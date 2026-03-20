---
title: 下单校验与支付渠道解耦：责任链+策略+模板方法的综合应用
date: 2026-03-20 14:00:00
categories:
  - 架构设计
tags:
  - 设计模式
  - 责任链模式
  - 策略模式
  - 模板方法
  - 支付系统
  - 代码设计
description: 本文介绍如何运用责任链模式实现下单环节的多维度前置校验，以及如何运用工厂+策略+模板方法实现多支付渠道的定制化对接，通过设计模式的组合应用提升代码的可扩展性和可维护性。
---

> 写在前面：在电商系统中，下单环节是交易链路的核心入口，承担着风控校验、业务规则校验、安全校验等多重职责。同时，随着支付渠道的多元化，如何优雅地对接多个支付渠道成为架构设计的关键挑战。本文通过两个实际案例，探讨设计模式在业务代码中的综合应用。

<!-- more -->

## 一、下单校验的核心挑战

### 1.1 校验场景的多样性

下单看似简单，实则涉及多层校验：

| 校验维度 | 示例 | 特点 |
|----------|------|------|
| **库存校验** | 商品是否有足够库存 | 数据查询型 |
| **价格校验** | 订单金额与商品价格是否一致 | 数据比对型 |
| **风控校验** | 用户是否存在风险行为 | 外部服务型 |
| **业务规则校验** | 用户是否满足购买条件 | 规则判断型 |
| **安全校验** | 请求是否合法、token是否有效 | 基础设施型 |

### 1.2 传统方式的困境

**传统顺序校验的问题**：当校验逻辑与业务逻辑混在一起时，每次新增或修改校验规则都需要改动核心代码，这违背了开闭原则。同时，校验顺序被代码固定，无法根据业务需求灵活调整。

```java
// ❌ 耦合示例：校验逻辑与业务逻辑混在一起
public Order createOrder(CreateOrderRequest request) {
    // 库存校验 - 硬编码，无法灵活配置
    if (!checkStock(request)) {
        throw new BusinessException("库存不足");
    }
    
    // 价格校验 - 新增校验必须修改这里
    if (!checkPrice(request)) {
        throw new BusinessException("价格已变动");
    }
    
    // 风控校验 - 顺序固化，无法调整
    if (!checkRisk(request)) {
        throw new BusinessException("存在风险行为");
    }
    
    // 业务规则校验
    if (!checkBusinessRule(request)) {
        throw new BusinessException("不满足购买条件");
    }
    
    // 订单创建
    return doCreateOrder(request);
}
```

**核心问题总结**：

| 问题 | 影响 |
|------|------|
| 校验逻辑与业务逻辑强耦合 | 代码难以维护 |
| 新增校验需要修改核心代码 | 违背开闭原则 |
| 校验顺序固化 | 无法灵活配置 |
| 校验失败难以定位 | 问题排查困难 |
| 无法短路 | 性能开销大 |

## 二、责任链模式的原理与应用

### 2.1 模式定义

**责任链模式的核心思想**：将请求的发送者和接收者解耦，让多个处理器（Handler）形成一条链，每个处理器只负责自己的校验逻辑，完成后决定是处理请求还是传递给下一个处理器。

这种设计的好处是：
1. **单一职责**：每个处理器只做一件事
2. **开闭原则**：新增校验只需添加新处理器，无需修改现有代码
3. **灵活配置**：通过调整处理器顺序来改变校验流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      责任链模式结构                                │
│                                                                 │
│  Client ──请求──► Handler1 ──传递──► Handler2 ──传递──► Handler3 │
│                      │                    │                    │
│                   处理请求             处理请求               处理请求  │
│                      │                    │                    │
│                   ◄──┘                   ▼                    │
│                                    [最终处理者]                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计：Handler 接口

**设计思想**：接口设计决定了整个模式的可扩展性。我们让 Handler 返回 `CheckResult` 而不是简单的 `boolean`，这样可以携带更丰富的错误信息，便于前端展示和问题排查。

```java
/**
 * 订单校验处理器接口
 * 
 * 设计要点：
 * 1. 返回 CheckResult 而非 boolean - 携带错误信息，方便定位问题
 * 2. 返回 this 支持链式调用 - 形成 Handler 链的关键
 * 3. 统一的校验方法签名 - 所有校验器遵循同一规范
 */
public interface OrderCheckHandler {
    
    /**
     * 设置下一个处理器
     * 返回 this 而非 void - 这是形成链式调用的关键
     * 使得可以这样写：handler1.setNext(handler2).setNext(handler3)
     */
    OrderCheckHandler setNext(OrderCheckHandler handler);
    
    /**
     * 执行校验
     * 返回 CheckResult - 包含成功/失败状态和错误信息
     * 而不是简单的 boolean，这样才能区分"校验失败"和"校验跳过"
     */
    CheckResult check(OrderCheckContext context);
}
```

### 2.3 关键实现：责任链组装

**设计思想**：通过 Spring 的依赖注入，我们让所有 Handler 自动被收集，然后按优先级排序、组装成链。这样新增 Handler 只需要添加新的 `@Component`，无需修改组装逻辑。

```java
/**
 * 校验链工厂
 * 
 * 设计要点：
 * 1. 利用 Spring 的 List 注入特性 - 自动收集所有 Handler 实现
 * 2. 通过 @Order 注解控制顺序 - 校验优先级可配置
 * 3. 链式调用 setNext() 组装 - 简洁直观
 */
@Component
public class OrderCheckChainFactory {
    
    @Autowired
    private List<OrderCheckHandler> handlers;  // Spring 自动注入所有实现
    
    /**
     * 组装校验链
     * 利用 @Order 注解或配置决定执行顺序
     */
    public OrderCheckHandler buildChain() {
        // 按优先级排序 - @Order 小的先执行
        handlers.sort(Comparator.comparingInt(h -> {
            Order an = h.getClass().getAnnotation(Order.class);
            return an != null ? an.value() : Integer.MAX_VALUE;
        }));
        
        // 组装链 - 通过 setNext 形成链
        OrderCheckHandler head = handlers.get(0);
        for (int i = 1; i < handlers.size(); i++) {
            handlers.get(i - 1).setNext(handlers.get(i));
        }
        
        return head;
    }
}
```

### 2.4 模板方法：Handler 基类

**设计思想**：使用模板方法模式定义校验的标准流程骨架。`check()` 方法是模板方法，它定义了通用的执行流程：前置校验 → 核心校验 → 传递下一个。子类只需实现 `doCheck()` 核心逻辑，无需关心流程控制。

这种设计的好处：
1. **复用流程**：所有校验器复用相同的校验流程
2. **聚焦核心**：子类只需关注自己的校验逻辑
3. **钩子扩展**：提供 `preCheck()` 钩子方法，子类可选择覆盖

```java
/**
 * 抽象基类：模板方法模式
 * 
 * 设计要点：
 * 1. 模板方法 check() - 定义校验的标准流程骨架
 *    - 流程：前置校验(preCheck) → 核心校验(doCheck) → 传递给下一个
 * 2. 抽象方法 doCheck() - 子类必须实现自己的校验逻辑
 * 3. 钩子方法 preCheck() - 子类可选择覆盖，用于条件判断
 * 4. 返回 this - 支持链式调用
 */
public abstract class AbstractOrderCheckHandler implements OrderCheckHandler {
    
    private OrderCheckHandler next;
    
    @Override
    public final OrderCheckHandler setNext(OrderCheckHandler handler) {
        this.next = handler;
        return handler;  // 返回 handler 而非 this，支持链式组装
    }
    
    /**
     * 模板方法：定义校验的标准流程
     * 使用 final 修饰 - 子类不能修改校验流程，只能实现 doCheck()
     */
    @Override
    public final CheckResult check(OrderCheckContext context) {
        // 1. 前置校验（钩子方法）- 子类可选择覆盖
        if (!preCheck(context)) {
            return CheckResult.skip();  // 跳过当前校验
        }
        
        // 2. 执行核心校验（抽象方法）- 子类必须实现
        CheckResult result = doCheck(context);
        if (!result.isSuccess()) {
            return result;  // 校验失败，直接返回，不再传递
        }
        
        // 3. 传递给下一个处理器
        if (next != null) {
            return next.check(context);
        }
        
        return CheckResult.success();
    }
    
    /**
     * 前置校验（钩子方法）
     * 子类可覆盖 - 用于条件判断，比如"只对高价值商品进行风控"
     */
    protected boolean preCheck(OrderCheckContext context) {
        return true;  // 默认放行
    }
    
    /**
     * 核心校验逻辑（抽象方法）
     * 子类必须实现 - 只关注自己的校验逻辑
     */
    protected abstract CheckResult doCheck(OrderCheckContext context);
}
```

### 2.5 具体实现：库存校验

**设计思想**：每个 Handler 只需要实现 `doCheck()` 方法，专注于自己的校验逻辑。校验结果放入 Context 供后续 Handler 使用，实现信息的链式传递。

```java
/**
 * 库存校验处理器
 * 
 * 设计要点：
 * 1. 只关注库存相关的校验 - 职责单一
 * 2. 将库存信息放入 Context - 供后续 Handler 使用
 * 3. 清晰的错误信息 - 便于前端展示
 */
@Component
@Order(10)  // 第一优先级执行
public class StockCheckHandler extends AbstractOrderCheckHandler {
    
    @Autowired
    private StockService stockService;
    
    @Override
    protected CheckResult doCheck(OrderCheckContext context) {
        CreateOrderRequest request = context.getRequest();
        
        // 查询库存
        StockInfo stock = stockService.getStock(request.getSkuId());
        
        // 校验逻辑
        if (stock == null) {
            return CheckResult.fail("商品不存在");
        }
        
        if (stock.getAvailable() < request.getQuantity()) {
            return CheckResult.fail("库存不足，当前可用：" + stock.getAvailable());
        }
        
        // 将库存信息放入上下文，供后续使用
        // 这样下游 Handler 可以直接使用，无需再次查询
        context.setAttribute("stockInfo", stock);
        
        return CheckResult.success();
    }
}
```

### 2.6 具体实现：风控校验

**设计思想**：通过覆盖 `preCheck()` 钩子方法，可以实现条件性校验。比如风控校验只针对高价值商品，低价值商品直接跳过，这样既保证安全又不影响性能。

```java
/**
 * 风控校验处理器
 * 
 * 设计要点：
 * 1. 覆盖 preCheck() - 实现条件性校验，只对高价值商品进行风控
 * 2. 调用外部风控服务 - 典型的外部依赖处理
 * 3. 将风控标签放入 Context - 供业务逻辑使用
 */
@Component
@Order(30)  // 第三优先级
public class RiskCheckHandler extends AbstractOrderCheckHandler {
    
    @Autowired
    private RiskService riskService;
    
    /**
     * 前置校验（钩子方法）
     * 只对金额超过 1000 的商品进行风控
     * 低价值商品直接跳过，提高性能
     */
    @Override
    protected boolean preCheck(OrderCheckContext context) {
        CreateOrderRequest request = context.getRequest();
        return request.getTotalAmount().compareTo(new BigDecimal("1000")) > 0;
    }
    
    @Override
    protected CheckResult doCheck(OrderCheckContext context) {
        CreateOrderRequest request = context.getRequest();
        
        // 调用风控服务
        RiskCheckResponse riskResponse = riskService.check(
            RiskCheckRequest.builder()
                .userId(request.getUserId())
                .skuId(request.getSkuId())
                .quantity(request.getQuantity())
                .amount(request.getTotalAmount())
                .build()
        );
        
        if (!riskResponse.isPass()) {
            return CheckResult.fail("存在风险行为：" + riskResponse.getReason());
        }
        
        // 记录风控标签，供后续业务逻辑使用
        context.setAttribute("riskTags", riskResponse.getTags());
        
        return CheckResult.success();
    }
}
```

### 2.7 责任链的调用

**设计思想**：调用方无需关心有多少个 Handler，也无需了解校验顺序。只需调用链的入口，链会自动执行所有校验并返回结果。这种设计让业务代码保持简洁。

```java
/**
 * 订单服务
 * 
 * 设计要点：
 * 1. 调用方与校验逻辑解耦 - 不需要知道有哪些校验器
 * 2. 统一的校验入口 - 构建链 → 执行校验 → 处理结果
 * 3. 异常统一处理 - 校验失败抛业务异常
 */
@Service
public class OrderService {
    
    @Autowired
    private OrderCheckChainFactory chainFactory;
    
    public Order createOrder(CreateOrderRequest request) {
        // 1. 构建校验上下文
        OrderCheckContext context = new OrderCheckContext(request);
        
        // 2. 获取校验链
        OrderCheckHandler chain = chainFactory.buildChain();
        
        // 3. 执行校验 - 调用方无需关心内部实现
        CheckResult result = chain.check(context);
        if (!result.isSuccess()) {
            throw new BusinessException(result.getMessage());
        }
        
        // 4. 执行业务逻辑
        return doCreateOrder(request);
    }
}
```

### 2.8 责任链模式优势总结

| 特性 | 传统方式 | 责任链模式 |
|------|----------|------------|
| **新增校验** | 修改核心代码 | 新增 Handler 类 |
| **校验顺序** | 代码顺序决定 | 通过 @Order 配置 |
| **复用性** | 难以复用 | Handler 可复用 |
| **可测试性** | 难以单独测试 | Handler 可单独测试 |
| **职责分离** | 耦合在一起 | 每个 Handler 单一职责 |
| **动态配置** | 硬编码 | 可配置化 |

## 三、多支付渠道的设计挑战

### 3.1 支付渠道的多样性

```
┌─────────────────────────────────────────────────────────┐
│                    支付渠道示意                            │
│                                                          │
│    ┌─────────────────────────────────────────────┐      │
│    │              统一支付入口                     │      │
│    └─────────────────┬───────────────────────────┘      │
│                      │                                    │
│         ┌────────────┼────────────┐                     │
│         │            │            │                     │
│         ▼            ▼            ▼                     │
│    ┌─────────┐ ┌─────────┐ ┌─────────┐                │
│    │ 微信支付 │ │ 支付宝  │ │ 银行卡  │                │
│    │  ━━━━━  │ │  ━━━━━  │ │  ━━━━━  │                │
│    │ appId   │ │ appId   │ │ merchant │                │
│    │ appKey  │ │ appKey  │ │ certPath │                │
│    │ sign    │ │ sign    │ │ sign     │                │
│    │ notify   │ │ notify   │ │ notify   │                │
│    └─────────┘ └─────────┘ └─────────┘                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 核心挑战

| 挑战 | 描述 |
|------|------|
| **接口差异** | 各渠道接口参数、签名、回调格式各异 |
| **差异化逻辑** | 不同渠道有独特的业务流程 |
| **扩展性** | 新增渠道不能影响现有代码 |
| **可测试性** | 支付涉及金钱，需要充分测试 |

## 四、策略模式的原理与应用

### 4.1 模式定义

**策略模式的核心思想**：将每个支付渠道的差异化逻辑封装成独立的策略类，定义统一的策略接口。通过多态，调用方可以透明地切换不同的支付渠道，而无需关心具体实现细节。

这种设计的好处：
1. **消除 if-else**：不再需要根据渠道类型写一堆判断
2. **开闭原则**：新增渠道只需添加新策略，无需修改调用方
3. **可测试性**：每个策略可以独立测试

```
┌─────────────────────────────────────────────────────────┐
│                    策略模式结构                            │
│                                                          │
│    ┌────────────┐                                        │
│    │  Context   │                                        │
│    │ (上下文)   │                                        │
│    └─────┬──────┘                                        │
│          │ uses                                         │
│          ▼                                                │
│    ┌────────────┐                                        │
│    │ Strategy   │ ◄──────── 接口                         │
│    │ (策略接口) │                                        │
│    └─────┬──────┘                                        │
│          │                                                │
│    ┌─────┴─────┐ ┌─────────┐ ┌─────────┐                │
│    │  Concrete │ │Concrete │ │Concrete │                │
│    │StrategyA  │ │StrategyB│ │StrategyC│                │
│    └───────────┘ └─────────┘ └─────────┘                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 4.2 策略接口设计

**设计思想**：策略接口定义了支付行为的契约。每个渠道的实现类都遵循这个契约，提供统一的接口。接口的设计要考虑：
1. **完整性**：涵盖支付的所有环节
2. **稳定性**：新增渠道不需要修改接口
3. **语义清晰**：方法名要能表达意图

```java
/**
 * 支付策略接口
 * 
 * 设计要点：
 * 1. 统一的接口 - 所有支付渠道遵循同一契约
 * 2. 封装差异化 - 各渠道的差异通过实现类内部处理
 * 3. 方法粒度适中 - 平衡灵活性和复杂度
 */
public interface PayStrategy {
    
    /**
     * 获取支持的支付渠道
     * 用于工厂根据渠道类型获取对应策略
     */
    PayChannel getChannel();
    
    /**
     * 构建支付请求
     * 不同渠道参数不同，通过策略封装差异
     */
    PayRequest buildPayRequest(PayContext context);
    
    /**
     * 解析回调参数
     * 各渠道回调格式不同
     */
    PayCallbackData parseCallback(Map<String, String> params);
    
    /**
     * 验证签名
     */
    boolean verifySign(Map<String, String> params);
    
    /**
     * 处理支付结果
     * 这里处理渠道特定的业务逻辑
     */
    PayResult handlePayResult(PayCallbackData data);
}
```

## 五、工厂模式的原理与应用

### 5.1 工厂模式与策略的结合

**设计思想**：工厂负责管理策略实例的创建和存储。通过 Spring 的依赖注入，所有策略实现类被自动收集到工厂中。调用方只需向工厂请求对应渠道的策略，工厂负责查找并返回。

这种设计的好处：
1. **调用方与实现解耦**：调用方不需要知道有哪些策略
2. **统一管理**：策略实例集中管理，便于监控和扩展
3. **延迟加载**：策略按需获取，而非提前全部加载

```java
/**
 * 支付策略工厂
 * 
 * 设计要点：
 * 1. 利用 Spring 的 List 注入 - 自动收集所有策略实现
 * 2. Map 存储策略实例 - 根据渠道类型快速查找
 * 3. 统一异常处理 - 不支持的渠道抛出明确异常
 */
@Component
public class PayStrategyFactory {
    
    private final Map<PayChannel, PayStrategy> strategyMap = new ConcurrentHashMap<>();
    
    /**
     * 初始化时注册所有策略
     * 利用构造方法注入，Spring 会自动收集所有 PayStrategy 实现
     */
    @Autowired
    public PayStrategyFactory(List<PayStrategy> strategies) {
        strategies.forEach(strategy -> {
            strategyMap.put(strategy.getChannel(), strategy);
        });
    }
    
    /**
     * 获取策略
     * 调用方只需指定渠道类型，工厂负责查找
     */
    public PayStrategy getStrategy(PayChannel channel) {
        PayStrategy strategy = strategyMap.get(channel);
        if (strategy == null) {
            throw new UnsupportedOperationException("不支持的支付渠道：" + channel);
        }
        return strategy;
    }
}
```

### 5.2 Spring 的自动注册机制

**设计思想**：利用 Spring 的 `@Component` 注解，所有策略实现类会被自动扫描并注册到容器中。结合工厂的 List 注入，所有策略被自动收集。这种"约定优于配置"的思想让扩展变得极其简单——只需添加新的策略类，无需修改任何配置。

```java
/**
 * 微信支付策略
 * 
 * 设计要点：
 * 1. @Component 注解 - Spring 自动扫描并注册
 * 2. 实现 PayStrategy 接口 - 遵循统一契约
 * 3. getChannel() 方法 - 向工厂声明支持微信支付
 */
// Spring 自动扫描，会被注入到 PayStrategyFactory
@Component
public class WechatPayStrategy implements PayStrategy {
    
    @Override
    public PayChannel getChannel() {
        return PayChannel.WECHAT;  // 向工厂声明
    }
    
    // ... 其他实现
}

/**
 * 支付宝策略
 * 同样自动注册，扩展只需添加新类
 */
@Component
public class AlipayStrategy implements PayStrategy {
    
    @Override
    public PayChannel getChannel() {
        return PayChannel.ALIPAY;
    }
    
    // ... 其他实现
}
```

## 六、模板方法在支付渠道的运用

### 6.1 抽象基类封装通用流程

**设计思想**：模板方法模式定义支付的标准流程骨架。`pay()` 方法是模板方法，它定义了支付的完整流程：参数校验 → 构建请求 → 发起支付 → 解析响应 → 创建记录 → 返回结果。

子类通过实现抽象方法（`doPay()`、`parseResponse()`）来处理渠道差异化，而通用逻辑（如参数校验、记录创建）被抽取到基类中复用。

```
┌────────────────────────────────────────────────────────────┐
│  模板方法 pay() 的执行流程                                  │
│                                                            │
│  1. validateParams()  ── 通用校验，各渠道复用              │
│              ↓                                            │
│  2. buildPayRequest() ── 可被子类覆盖                     │
│              ↓                                            │
│  3. doPay() ◄────────── 抽象方法，子类实现差异             │
│              ↓                                            │
│  4. parseResponse() ◄──────── 抽象方法                    │
│              ↓                                            │
│  5. createPayRecord() ── 通用记录，各渠道复用              │
│              ↓                                            │
│  6. buildResponse()  ── 可被子类覆盖                       │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

```java
/**
 * 支付策略抽象基类：模板方法模式
 * 
 * 设计要点：
 * 1. 模板方法 pay() - 定义支付的完整流程骨架
 *    - 步骤固定：校验 → 构建 → 支付 → 解析 → 记录 → 返回
 *    - 部分步骤通用，部分步骤抽象
 * 2. 抽象方法 doPay()、parseResponse() - 子类实现渠道差异化
 * 3. 可覆盖方法 validateParams()、buildPayRequest() - 子类可定制
 * 4. final 修饰模板方法 - 确保流程不被破坏
 */
public abstract class AbstractPayStrategy implements PayStrategy {
    
    @Autowired
    protected PayOrderService payOrderService;
    
    @Autowired
    protected PayConfigService payConfigService;
    
    /**
     * 模板方法：定义支付的完整流程
     * final 修饰 - 子类不能修改标准流程，只能实现抽象方法
     */
    @Override
    public final PayResponse pay(PayContext context) {
        // 1. 参数校验 - 通用逻辑，各渠道复用
        validateParams(context);
        
        // 2. 构建渠道请求 - 子类可覆盖定制
        PayRequest request = buildPayRequest(context);
        
        // 3. 发起支付 - 抽象方法，子类实现差异化
        PayChannelResponse channelResponse = doPay(request);
        
        // 4. 解析响应 - 抽象方法，子类实现差异化
        PayResult result = parseResponse(channelResponse);
        
        // 5. 创建支付记录 - 通用逻辑，各渠道复用
        createPayRecord(context, result);
        
        // 6. 返回支付参数 - 子类可覆盖定制
        return buildResponse(result);
    }
    
    /**
     * 参数校验（可覆盖）
     * 子类可覆盖添加渠道特定的校验
     */
    protected void validateParams(PayContext context) {
        Assert.notNull(context.getOrderId(), "订单号不能为空");
        Assert.notNull(context.getAmount(), "金额不能为空");
    }
    
    /**
     * 构建渠道请求（可覆盖）
     * 子类可覆盖添加渠道特定的参数
     */
    protected PayRequest buildPayRequest(PayContext context) {
        PayRequest request = new PayRequest();
        request.setOutTradeNo(context.getOrderId());
        request.setTotalAmount(context.getAmount());
        request.setBody(context.getSubject());
        return request;
    }
    
    /**
     * 发起支付（抽象方法）
     * 不同渠道实现不同 - 这是差异化的核心
     */
    protected abstract PayChannelResponse doPay(PayRequest request);
    
    /**
     * 解析响应（抽象方法）
     * 不同渠道响应格式不同
     */
    protected abstract PayResult parseResponse(PayChannelResponse response);
    
    /**
     * 构建返回参数（可覆盖）
     * 不同渠道返回格式不同
     */
    protected PayResponse buildResponse(PayResult result) {
        return PayResponse.builder()
            .success(result.isSuccess())
            .payUrl(result.getPayUrl())
            .build();
    }
}
```

### 6.2 具体实现：微信支付

**设计思想**：子类只需要实现 `doPay()` 和 `parseResponse()` 两个抽象方法。微信特有的参数（如 appId、sign）通过覆盖 `buildPayRequest()` 添加，微信特有的返回参数通过覆盖 `buildResponse()` 构建。

```java
/**
 * 微信支付策略
 * 
 * 设计要点：
 * 1. extends AbstractPayStrategy - 复用标准支付流程
 * 2. 只实现差异部分 - doPay()、parseResponse()、buildResponse()
 * 3. 覆盖 buildPayRequest() - 添加微信特有参数
 * 4. 覆盖 buildResponse() - 构建微信调起支付的参数
 */
@Component
public class WechatPayStrategy extends AbstractPayStrategy {
    
    @Override
    public PayChannel getChannel() {
        return PayChannel.WECHAT;
    }
    
    /**
     * 覆盖：添加微信特有参数
     */
    @Override
    protected PayRequest buildPayRequest(PayContext context) {
        PayRequest request = super.buildPayRequest(context);
        // 微信特有参数
        request.setAppId(getConfig("wechat.appId"));
        request.setMchId(getConfig("wechat.mchId"));
        request.setNotifyUrl(getConfig("wechat.notifyUrl"));
        return request;
    }
    
    /**
     * 实现：调用微信统一下单接口
     */
    @Override
    protected PayChannelResponse doPay(PayRequest request) {
        // 调用微信统一下单接口
        return wechatClient.unifiedOrder(request);
    }
    
    /**
     * 实现：解析微信响应
     */
    @Override
    protected PayResult parseResponse(PayChannelResponse response) {
        WechatResponse wechat = (WechatResponse) response;
        
        PayResult result = new PayResult();
        result.setSuccess("SUCCESS".equals(wechat.getReturnCode()));
        result.setTradeNo(wechat.getPrepayId());
        result.setPayUrl(buildWechatPayUrl(wechat.getPrepayId()));
        return result;
    }
    
    /**
     * 覆盖：构建微信调起支付的参数
     */
    @Override
    protected PayResponse buildResponse(PayResult result) {
        // 构建微信调起支付的参数
        Map<String, String> params = new HashMap<>();
        params.put("appId", getConfig("wechat.appId"));
        params.put("timeStamp", String.valueOf(System.currentTimeMillis()));
        params.put("nonceStr", UUID.randomUUID().toString());
        params.put("package", "prepay_id=" + result.getTradeNo());
        params.put("signType", "MD5");
        params.put("paySign", sign(params));
        
        return PayResponse.builder()
            .success(result.isSuccess())
            .platformParams(params)  // 微信特殊返回
            .build();
    }
}
```

### 6.3 具体实现：支付宝

**设计思想**：与微信支付对比，支付宝的实现只有参数名和调用方式不同，代码结构完全一致。这正是策略模式和模板方法组合使用的威力——新增支付渠道只需复制一个策略类，修改差异化部分即可。

```java
/**
 * 支付宝策略
 * 
 * 设计要点：
 * 1. 结构与微信完全一致 - 证明模式带来的规范性
 * 2. 只修改差异化部分 - 参数名、调用方式、响应格式
 * 3. 新增渠道只需复制此类 - 极其简单的扩展
 */
@Component
public class AlipayPayStrategy extends AbstractPayStrategy {
    
    @Override
    public PayChannel getChannel() {
        return PayChannel.ALIPAY;
    }
    
    @Override
    protected PayRequest buildPayRequest(PayContext context) {
        PayRequest request = super.buildPayRequest(context);
        // 支付宝特有参数
        request.setAppId(getConfig("alipay.appId"));
        request.setMethod("alipay.trade.app.pay");
        request.setReturnUrl(getConfig("alipay.returnUrl"));
        request.setNotifyUrl(getConfig("alipay.notifyUrl"));
        return request;
    }
    
    @Override
    protected PayChannelResponse doPay(PayRequest request) {
        // 调用支付宝支付接口
        return alipayClient.pay(request);
    }
    
    @Override
    protected PayResult parseResponse(PayChannelResponse response) {
        AlipayResponse alipay = (AlipayResponse) response;
        
        PayResult result = new PayResult();
        result.setSuccess("ACCEPTED".equals(alipay.getResultStatus()));
        result.setTradeNo(alipay.getTradeNo());
        result.setPayUrl(alipay.getQrCode());
        return result;
    }
    
    @Override
    protected PayResponse buildResponse(PayResult result) {
        // 构建支付宝的表单参数
        return PayResponse.builder()
            .success(result.isSuccess())
            .formHtml(buildAlipayForm(result.getTradeNo()))
            .build();
    }
}
```

## 七、统一调用入口

**设计思想**：通过统一的 Service 层对外暴露，调用方无需知道使用了什么设计模式。工厂负责策略的选择，模板方法负责流程的控制，Service 只负责协调。

```java
/**
 * 支付服务
 * 
 * 设计要点：
 * 1. 统一入口 - 调用方不需要知道策略工厂的存在
 * 2. 透明路由 - 根据渠道自动选择对应策略
 * 3. 回调统一处理 - 自动路由到对应策略处理
 */
@Service
public class PayService {
    
    @Autowired
    private PayStrategyFactory strategyFactory;
    
    /**
     * 发起支付
     * 调用方无需关心具体渠道 - 工厂自动路由
     */
    public PayResponse pay(PayContext context) {
        // 1. 获取对应的策略 - 工厂负责查找
        PayStrategy strategy = strategyFactory.getStrategy(context.getChannel());
        
        // 2. 统一调用 - 模板方法自动处理
        return strategy.pay(context);
    }
    
    /**
     * 处理回调
     * 统一入口，自动路由到对应策略
     */
    public void handleCallback(PayChannel channel, Map<String, String> params) {
        // 1. 获取策略
        PayStrategy strategy = strategyFactory.getStrategy(channel);
        
        // 2. 验证签名
        if (!strategy.verifySign(params)) {
            throw new SecurityException("签名验证失败");
        }
        
        // 3. 解析回调
        PayCallbackData data = strategy.parseCallback(params);
        
        // 4. 处理结果
        strategy.handlePayResult(data);
    }
}
```

## 八、模式组合优势

### 8.1 设计模式协同关系

```
┌─────────────────────────────────────────────────────────────┐
│                    设计模式协同关系                            │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    策略模式                           │    │
│  │  解决的问题：支付渠道的差异化处理                       │    │
│  │  核心机制：接口抽象 + 多态实现                          │    │
│  └────────────────────────┬────────────────────────────┘    │
│                           │                                  │
│  ┌────────────────────────┴────────────────────────────┐    │
│  │                    模板方法模式                        │    │
│  │  解决的问题：支付流程的标准化与差异化共存                │    │
│  │  核心机制：抽象基类定义骨架，子类实现差异化              │    │
│  └────────────────────────┬────────────────────────────┘    │
│                           │                                  │
│  ┌────────────────────────┴────────────────────────────┐    │
│  │                    工厂模式                           │    │
│  │  解决的问题：策略的创建与管理                          │    │
│  │  核心机制：工厂统一管理，策略按需获取                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 责任链与策略的对比

| 维度 | 责任链模式 | 策略模式 |
|------|------------|----------|
| **目的** | 依次处理请求 | 选择算法执行 |
| **关系** | Handler之间是链式 | Strategy之间是平级 |
| **执行** | 依次执行，直到处理 | 选择一个执行 |
| **适用** | 校验链、过滤器链 | 算法选择、渠道切换 |
| **扩展** | 新增 Handler | 新增 Strategy |

### 8.3 实际选择建议

| 场景 | 推荐模式 |
|------|----------|
| 订单校验（依次校验） | 责任链模式 |
| 支付渠道选择 | 策略模式 |
| 支付流程标准化 | 模板方法模式 |
| 策略实例管理 | 工厂模式 |
| 复杂校验+渠道 | 责任链+策略组合 |

## 九、总结

### 9.1 设计模式的核心价值

1. **解耦**：将变化的部分封装起来，减少耦合
2. **复用**：通用逻辑抽取到基类，子类只关注差异
3. **扩展**：新增功能无需修改现有代码（开闭原则）
4. **可测**：每个类职责单一，易于单元测试

### 9.2 模式选择的思考框架

```
遇到代码设计问题时，问自己：
                                        
  1. "我的代码中哪些部分是会变化的？"
     → 找出变化点
                                        
  2. "这些变化点之间是什么关系？"
     → 链式处理？ 还是选择执行？
                                        
  3. "有没有通用的处理流程？"
     → 需要模板方法
                                        
  4. "如何管理这些变化的实例？"
     → 需要工厂模式
```

### 9.3 本方案架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        调用层                                 │
│                    PayService.pay()                          │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      工厂层                                   │
│                   PayStrategyFactory                          │
│              管理策略实例，按渠道类型查找                      │
└─────────────────────────────┬───────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        ┌─────────┐     ┌─────────┐     ┌─────────┐
        │ 微信策略 │     │ 支付宝策略│     │ 银行卡策略│
        └────┬────┘     └────┬────┘     └────┬────┘
             │               │               │
             └───────────────┴───────────────┘
                           │
              ┌────────────┴────────────┐
              │      模板方法基类        │
              │  AbstractPayStrategy     │
              │  ┌──────────────────┐  │
              │  │ validateParams() │  │ ← 通用
              │  │ buildPayRequest()│  │ ← 可覆盖
              │  │ doPay() ◄──抽象  │  │ ← 差异化
              │  │ parseResponse()◄抽象│ │ ← 差异化
              │  │ createPayRecord() │  │ ← 通用
              │  │ buildResponse()   │  │ ← 可覆盖
              │  └──────────────────┘  │
              └───────────────────────┘
```

如果你也在设计类似的系统，希望这些设计思路对你有所启发。

---

*本文作者：李晓阳，电子科技大学计算机科学与技术专业在读研究生，专注于 Java 开发与分布式系统设计。*
