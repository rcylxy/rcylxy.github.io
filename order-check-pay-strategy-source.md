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

```java
// ❌ 传统的顺序校验：耦合严重，难以维护
public Order createOrder(CreateOrderRequest request) {
    // 库存校验
    if (!checkStock(request)) {
        throw new BusinessException("库存不足");
    }
    
    // 价格校验
    if (!checkPrice(request)) {
        throw new BusinessException("价格已变动");
    }
    
    // 风控校验
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

问题：
1. 校验逻辑与业务逻辑强耦合
2. 新增校验需要修改核心代码
3. 校验顺序固化，无法灵活配置
4. 校验失败难以定位是哪个环节
5. 无法支持校验结果的短路

## 二、责任链模式的原理与应用

### 2.1 模式定义

**责任链模式（Chain of Responsibility）**：将请求的发送者和接收者解耦，让多个对象都有机会处理请求，从而形成一条责任链。

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

### 2.2 核心设计：Handler 抽象

```java
/**
 * 订单校验处理器接口
 * 关键设计点：
 * 1. 返回 CheckResult 而非 boolean，支持更丰富的错误信息
 * 2. 包含 order 属性，支持链式调用
 * 3. 支持设置下一个处理器，形成链
 */
public interface OrderCheckHandler {
    
    /**
     * 设置下一个处理器
     * 这是责任链模式的关键：通过 setNext 形成链
     */
    OrderCheckHandler setNext(OrderCheckHandler handler);
    
    /**
     * 执行校验
     * 返回 CheckResult 而不是简单 boolean
     */
    CheckResult check(OrderCheckContext context);
}
```

### 2.3 关键实现：责任链组装

```java
/**
 * 校验链工厂
 * 关键设计点：
 * 1. 通过配置决定校验顺序
 * 2. 链式调用 setNext() 组装
 * 3. 支持动态调整校验规则
 */
@Component
public class OrderCheckChainFactory {
    
    @Autowired
    private List<OrderCheckHandler> handlers;  // 自动注入所有 Handler
    
    /**
     * 组装校验链
     * 通过 @Order 注解或配置决定顺序
     */
    public OrderCheckHandler buildChain() {
        // 按优先级排序
        handlers.sort(Comparator.comparingInt(h -> {
            Order an = h.getClass().getAnnotation(Order.class);
            return an != null ? an.value() : Integer.MAX_VALUE;
        }));
        
        // 组装链
        OrderCheckHandler head = handlers.get(0);
        for (int i = 1; i < handlers.size(); i++) {
            handlers.get(i - 1).setNext(handlers.get(i));
        }
        
        return head;
    }
}
```

### 2.4 模板方法：Handler 基类

```java
/**
 * 抽象基类：模板方法模式
 * 定义校验的标准流程骨架
 */
public abstract class AbstractOrderCheckHandler implements OrderCheckHandler {
    
    private OrderCheckHandler next;
    
    @Override
    public final OrderCheckHandler setNext(OrderCheckHandler handler) {
        this.next = handler;
        return handler;  // 返回下一个 handler，支持链式调用
    }
    
    /**
     * 模板方法：定义校验的标准流程
     * 子类只需实现 doCheck() 核心逻辑
     */
    @Override
    public final CheckResult check(OrderCheckContext context) {
        // 1. 前置校验（可选）
        if (!preCheck(context)) {
            return CheckResult.skip();  // 跳过当前校验
        }
        
        // 2. 执行核心校验
        CheckResult result = doCheck(context);
        if (!result.isSuccess()) {
            return result;  // 校验失败，直接返回
        }
        
        // 3. 传递给下一个处理器
        if (next != null) {
            return next.check(context);
        }
        
        return CheckResult.success();
    }
    
    /**
     * 前置校验（钩子方法）
     * 子类可选择覆盖
     */
    protected boolean preCheck(OrderCheckContext context) {
        return true;
    }
    
    /**
     * 核心校验逻辑（抽象方法）
     * 子类必须实现
     */
    protected abstract CheckResult doCheck(OrderCheckContext context);
}
```

**模板方法模式的关键**：

```
┌────────────────────────────────────────────────────┐
│     模板方法：check()                               │
│  ┌──────────────────────────────────────────────┐  │
│  │ 1. preCheck() ← 钩子方法，子类可覆盖          │  │
│  │ 2. doCheck() ← 抽象方法，子类必须实现          │  │
│  │ 3. next.check() ← 链式传递                    │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### 2.5 具体实现：库存校验

```java
/**
 * 库存校验处理器
 * 关注点分离：只负责库存相关的校验逻辑
 */
@Component
@Order(10)  // 第一优先级
public class StockCheckHandler extends AbstractOrderCheckHandler {
    
    @Autowired
    private StockService stockService;
    
    @Override
    protected CheckResult doCheck(OrderCheckContext context) {
        CreateOrderRequest request = context.getRequest();
        
        // 查询库存
        StockInfo stock = stockService.getStock(request.getSkuId());
        
        if (stock == null) {
            return CheckResult.fail("商品不存在");
        }
        
        if (stock.getAvailable() < request.getQuantity()) {
            return CheckResult.fail("库存不足，当前可用："
                + stock.getAvailable());
        }
        
        // 将库存信息放入上下文，供后续使用
        context.setAttribute("stockInfo", stock);
        
        return CheckResult.success();
    }
}
```

### 2.6 具体实现：风控校验

```java
/**
 * 风控校验处理器
 * 关键设计：通过外部服务进行校验
 */
@Component
@Order(30)  // 第三优先级
public class RiskCheckHandler extends AbstractOrderCheckHandler {
    
    @Autowired
    private RiskService riskService;
    
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
            return CheckResult.fail("存在风险行为："
                + riskResponse.getReason());
        }
        
        // 记录风控标签
        context.setAttribute("riskTags", riskResponse.getTags());
        
        return CheckResult.success();
    }
    
    /**
     * 覆盖前置校验：只对特定商品进行风控校验
     */
    @Override
    protected boolean preCheck(OrderCheckContext context) {
        CreateOrderRequest request = context.getRequest();
        // 简化逻辑：仅对高价值商品进行风控
        return request.getTotalAmount().compareTo(new BigDecimal("1000")) > 0;
    }
}
```

### 2.7 责任链的调用

```java
/**
 * 订单服务
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
        
        // 3. 执行校验
        CheckResult result = chain.check(context);
        if (!result.isSuccess()) {
            throw new BusinessException(result.getMessage());
        }
        
        // 4. 执行业务逻辑
        return doCreateOrder(request);
    }
}
```

### 2.8 模式优势总结

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

**策略模式（Strategy Pattern）**：定义一系列算法，将每个算法封装起来，并使它们可以互换。

```
┌─────────────────────────────────────────────────────────┐
│                    策略模式结构                            │
│                                                          │
│    ┌────────────┐                                        │
│    │  Context   │                                        │
│    │ (上下文)   │                                        │
│    └─────┬──────┘                                        │
│          │                                                │
│          │ uses                                         │
│          ▼                                                │
│    ┌────────────┐                                        │
│    │ Strategy   │ ◄──────── 接口                         │
│    │ (策略接口) │                                        │
│    └─────┬──────┘                                        │
│          │                                                │
│    ┌─────┴─────┐ ┌─────────┐ ┌─────────┐                │
│    │  Concrete │ │Concrete │ │Concrete │                │
│    │StrategyA │ │StrategyB│ │StrategyC│                │
│    └───────────┘ └─────────┘ └─────────┘                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 4.2 策略接口设计

```java
/**
 * 支付策略接口
 * 关键设计：封装各渠道的差异化逻辑
 */
public interface PayStrategy {
    
    /**
     * 获取支持的支付渠道
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

```java
/**
 * 支付策略工厂
 * 关键设计：通过工厂管理策略实例
 */
@Component
public class PayStrategyFactory {
    
    private final Map<PayChannel, PayStrategy> strategyMap = new ConcurrentHashMap<>();
    
    /**
     * 初始化时注册所有策略
     */
    @Autowired
    public PayStrategyFactory(List<PayStrategy> strategies) {
        strategies.forEach(strategy -> {
            strategyMap.put(strategy.getChannel(), strategy);
        });
    }
    
    /**
     * 获取策略
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

```java
/**
 * 微信支付策略
 * 通过 @Component 自动注册到工厂
 */
@Component
public class WechatPayStrategy implements PayStrategy {
    
    @Override
    public PayChannel getChannel() {
        return PayChannel.WECHAT;
    }
    
    // ... 其他实现
}

/**
 * 支付宝策略
 * 同样自动注册
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

```java
/**
 * 支付策略抽象基类
 * 模板方法模式：定义支付的标准流程骨架
 */
public abstract class AbstractPayStrategy implements PayStrategy {
    
    @Autowired
    protected PayOrderService payOrderService;
    
    @Autowired
    protected PayConfigService payConfigService;
    
    /**
     * 模板方法：定义支付的完整流程
     * ┌────────────────────────────────────────────┐
     * │  1. 参数校验                                │
     * │  2. 构建渠道请求                             │
     * │  3. 发起支付 ←─── 抽象方法，子类实现          │
     * │  4. 解析响应                                │
     * │  5. 创建支付记录                             │
     * │  6. 返回支付参数                             │
     * └────────────────────────────────────────────┘
     */
    @Override
    public final PayResponse pay(PayContext context) {
        // 1. 参数校验
        validateParams(context);
        
        // 2. 构建渠道请求
        PayRequest request = buildPayRequest(context);
        
        // 3. 发起支付（子类实现）
        PayChannelResponse channelResponse = doPay(request);
        
        // 4. 解析响应
        PayResult result = parseResponse(channelResponse);
        
        // 5. 创建支付记录
        createPayRecord(context, result);
        
        // 6. 返回支付参数
        return buildResponse(result);
    }
    
    /**
     * 参数校验（钩子方法）
     */
    protected void validateParams(PayContext context) {
        // 通用校验逻辑
        Assert.notNull(context.getOrderId(), "订单号不能为空");
        Assert.notNull(context.getAmount(), "金额不能为空");
    }
    
    /**
     * 构建渠道请求
     * 子类可覆盖定制
     */
    protected PayRequest buildPayRequest(PayContext context) {
        PayRequest request = new PayRequest();
        request.setOutTradeNo(context.getOrderId());
        request.setTotalAmount(context.getAmount());
        request.setBody(context.getSubject());
        // ... 通用参数设置
        return request;
    }
    
    /**
     * 发起支付（抽象方法）
     * 不同渠道实现不同
     */
    protected abstract PayChannelResponse doPay(PayRequest request);
    
    /**
     * 解析响应（抽象方法）
     */
    protected abstract PayResult parseResponse(PayChannelResponse response);
    
    /**
     * 构建返回参数
     * 子类可覆盖
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

```java
/**
 * 微信支付策略
 * 只需关注微信特定的逻辑
 */
@Component
public class WechatPayStrategy extends AbstractPayStrategy {
    
    @Override
    public PayChannel getChannel() {
        return PayChannel.WECHAT;
    }
    
    @Override
    protected PayRequest buildPayRequest(PayContext context) {
        PayRequest request = super.buildPayRequest(context);
        // 微信特有参数
        request.setAppId(getConfig("wechat.appId"));
        request.setMchId(getConfig("wechat.mchId"));
        request.setNotifyUrl(getConfig("wechat.notifyUrl"));
        return request;
    }
    
    @Override
    protected PayChannelResponse doPay(PayRequest request) {
        // 调用微信统一下单接口
        return wechatClient.unifiedOrder(request);
    }
    
    @Override
    protected PayResult parseResponse(PayChannelResponse response) {
        // 解析微信返回的预支付交易会话标识
        WechatResponse wechat = (WechatResponse) response;
        
        PayResult result = new PayResult();
        result.setSuccess("SUCCESS".equals(wechat.getReturnCode()));
        result.setTradeNo(wechat.getPrepayId());
        result.setPayUrl(buildWechatPayUrl(wechat.getPrepayId()));
        return result;
    }
    
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

```java
/**
 * 支付宝策略
 * 与微信支付对比，差异化一目了然
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

```java
/**
 * 支付服务
 * 对外暴露的统一入口
 */
@Service
public class PayService {
    
    @Autowired
    private PayStrategyFactory strategyFactory;
    
    /**
     * 发起支付
     * 调用方无需关心具体渠道
     */
    public PayResponse pay(PayContext context) {
        // 1. 获取对应的策略
        PayStrategy strategy = strategyFactory.getStrategy(context.getChannel());
        
        // 2. 统一调用（模板方法自动处理）
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
              │  │ validateParams() │  │
              │  │ buildPayRequest()│  │
              │  │ doPay() ◄──抽象  │  │
              │  │ parseResponse()◄抽象│  │
              │  │ createPayRecord() │  │
              │  │ buildResponse()   │  │
              │  └──────────────────┘  │
              └───────────────────────┘
```

如果你也在设计类似的系统，希望这些设计思路对你有所启发。

---

*本文作者：李晓阳，电子科技大学计算机科学与技术专业在读研究生，专注于 Java 开发与分布式系统设计。*
