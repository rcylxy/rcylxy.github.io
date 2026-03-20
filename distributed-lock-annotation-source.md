---
title: 基于"一锁二判三更新"实现支付幂等
date: 2026-03-20 10:00:00
categories:
  - 架构设计
tags:
  - 幂等
  - 分布式事务
  - 支付系统
  - 消息队列
  - 架构设计
  - 设计模式
description: 本文介绍如何基于"一锁二判三更新"的设计模式实现支付系统的幂等性控制，避免订单消息的重复消费，确保支付流程的可靠性和一致性。
---

> 写在前面：在分布式系统中，支付环节是资金安全的关键。任何重复扣款、重复退款都可能造成严重的经济损失。本文介绍一种"一锁二判三更新"的设计模式，通过多层次的幂等控制，确保支付流程的可靠性和一致性。

<!-- more -->

## 一、为什么支付幂等如此重要？

### 1.1 问题场景

在分布式支付系统中，消息重复消费是导致支付事故的高频原因：

| 场景 | 问题描述 |
|------|----------|
| **网络抖动** | 支付回调网络超时，触发重试 |
| **消费者重启** | 消息消费者重启，消息重新投递 |
| **MQ重试机制** | 消息队列自动重试失败消息 |
| **用户重复点击** | 用户快速点击支付按钮 |
| **幂等号重用** | 同一业务使用相同幂等号 |

### 1.2 问题后果

```
┌─────────────────────────────────────────────────────────────────┐
│                        支付回调场景                                │
│                                                                 │
│  支付成功 → 回调通知 → 网络超时 → MQ重试 → ???                       │
│                                             ↓                    │
│                                    ┌─────────────┐              │
│                                    │ 重复通知！   │              │
│                                    └─────────────┘              │
│                                             ↓                    │
│                                    ┌─────────────┐              │
│                                    │ 重复发货！   │              │
│                                    │ 重复扣款！   │              │
│                                    └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 核心原则

**支付幂等的核心原则**：
1. **接口幂等**：同一个请求多次调用，结果一致
2. **消息幂等**：同一条消息被消费多次，只生效一次
3. **补偿幂等**：失败重试时，不会造成数据不一致

## 二、"一锁二判三更新"设计模式

### 2.1 模式概述

"一锁二判三更新"是一种多层防护的幂等设计模式：

| 层级 | 名称 | 作用 | 实现方式 |
|------|------|------|----------|
| **一锁** | 数据层锁 | 防止并发写入 | 分布式锁 / 数据库唯一索引 |
| **二判** | 幂等性判断 | 识别重复请求 | 幂等号查询 / 状态判断 |
| **三更新** | 分阶段更新 | 确保更新安全 | 预扣 → 确认 / 状态机 |

### 2.2 核心设计思想

#### 为什么需要三层防护？

**单层判断的局限性**：

```java
// 反面示例：单一判断的并发问题
public void pay(PayRequest request) {
    // 1. 检查是否已支付
    if (isPaid(request.getOrderId())) {
        return; // 已被支付，直接返回
    }
    // 2. 执行支付
    doPay(request);
}
```

问题：当两个请求同时到达时，可能都通过第1步的判断，导致重复支付。

**多层防护的优势**：

```java
// ✓ 多层防护的并发安全
public void pay(PayRequest request) {
    // 一锁：获取分布式锁
    RLock lock = redissonClient.getLock("pay:" + request.getOrderId());
    try {
        // 二判：双重判断
        // 第一次判断：查询支付记录是否存在
        PayOrder existPayOrder = findByIdentifier(request.getIdentifier());
        if (existPayOrder != null) {
            return; // 幂等返回
        }
        
        // 第二次判断：检查订单状态
        if (isPaid(request.getOrderId())) {
            return; // 已被支付
        }
        
        // 三更新：分阶段更新
        // 阶段1：创建支付单（中间状态）
        createPayOrder(request);
        // 阶段2：调用支付渠道
        callPayChannel(request);
        // 阶段3：更新支付结果（终态）
        updatePayResult(request);
        
    } finally {
        lock.unlock();
    }
}
```

## 三、核心实现

### 3.1 幂等号设计

幂等号（Identifier）是幂等控制的核心，它需要满足：

1. **唯一性**：全局唯一
2. **业务含义**：可追溯
3. **不变性**：同一业务操作使用相同标识

```java
public class MessageBody {
    /**
     * 幂等号
     * 格式：业务类型_业务ID_操作类型
     * 示例：PAY_ORDER_123456_CREATE
     */
    private String identifier;
    
    /**
     * 消息体
     */
    private String body;
}

// 消息发送时自动生成幂等号
public boolean send(String topic, Object message) {
    MessageBody messageBody = new MessageBody()
        .setIdentifier(generateIdentifier(message))  // 自动生成
        .setBody(JSON.toJSONString(message));
    return streamBridge.send(topic, messageBody);
}
```

### 3.2 支付单创建（幂等）

```java
public PayOrder create(PayCreateRequest request) {
    // 一锁：使用乐观锁
    // 通过唯一索引保证：bizNo + payerId + bizType + payChannel 唯一
    
    // 二判：检查是否已存在
    PayOrder existPayOrder = payOrderMapper.selectByBizNoAndPayer(
        request.getPayerId(),
        request.getBizNo(),
        request.getBizType().name(),
        request.getPayChannel().name()
    );
    
    // 幂等返回：已存在且未过期
    if (existPayOrder != null) {
        if (existPayOrder.getOrderState() != PayOrderState.EXPIRED) {
            return existPayOrder;
        }
    }
    
    // 三更新：创建支付单
    PayOrder payOrder = PayOrder.create(request);
    payOrderMapper.insert(payOrder);
    
    return payOrder;
}
```

### 3.3 支付成功回调（幂等）

```java
public boolean paySuccess(PaySuccessEvent event) {
    // 一锁：分布式锁
    RLock lock = redissonClient.getLock("pay:success:" + event.getPayOrderId());
    lock.lock();
    
    try {
        // 二判：第一次判断 - 检查支付单是否存在
        PayOrder payOrder = payOrderMapper.selectById(event.getPayOrderId());
        if (payOrder == null) {
            return false;
        }
        
        // 二判：第二次判断 - 检查是否已支付（核心幂等）
        if (payOrder.isPaid()) {
            log.info("Pay order already paid, idempotent return. orderId={}", event.getPayOrderId());
            return true;  // 幂等返回
        }
        
        // 二判：第三次判断 - 检查订单状态（交易订单）
        TradeOrder tradeOrder = tradeOrderMapper.selectByOrderId(event.getBizNo());
        if (tradeOrder != null && tradeOrder.isPaid()) {
            log.info("Trade order already paid, idempotent return. orderId={}", event.getBizNo());
            return true;
        }
        
        // 三更新：分阶段更新
        // 阶段1：更新支付单状态
        updatePayOrderState(payOrder, PayOrderState.PAID);
        
        // 阶段2：更新交易订单状态（发送消息）
        sendOrderPaidMessage(event.getBizNo());
        
        return true;
        
    } finally {
        lock.unlock();
    }
}
```

### 3.4 订单状态更新（幂等）

```java
public OrderResponse doExecute(BaseOrderUpdateRequest request, Consumer<TradeOrder> action) {
    // 一锁：分布式锁
    RLock lock = redissonClient.getLock("order:update:" + request.getOrderId());
    lock.lock();
    
    try {
        // 二判：第一次判断 - 查询订单
        TradeOrder existOrder = orderMapper.selectByOrderId(request.getOrderId());
        
        // 二判：第二次判断 - 幂等号检查（防重复消费）
        TradeOrderStream existStream = orderStreamMapper.selectByIdentifier(
            request.getIdentifier(),
            request.getOrderEvent().name(),
            request.getOrderId()
        );
        
        if (existStream != null) {
            log.info("Order event already processed, idempotent return. identifier={}", request.getIdentifier());
            return OrderResponse.buildDuplicated(existStream.getOrderId(), existStream.getId().toString());
        }
        
        // 二判：第三次判断 - 状态检查
        if (isTerminalState(existOrder, request.getOrderEvent())) {
            log.info("Order already in terminal state, skip. orderId={}", request.getOrderId());
            return OrderResponse.buildDuplicated(existOrder.getOrderId(), null);
        }
        
        // 三更新：执行更新
        // 阶段1：执行业务逻辑
        action.accept(existOrder);
        
        // 阶段2：记录处理流水
        TradeOrderStream stream = new TradeOrderStream()
            .setIdentifier(request.getIdentifier())
            .setOrderEvent(request.getOrderEvent())
            .setOrderId(request.getOrderId());
        orderStreamMapper.insert(stream);
        
        // 阶段3：更新订单状态
        orderMapper.updateById(existOrder);
        
        return OrderResponse.buildSuccess(existOrder.getOrderId(), stream.getId().toString());
        
    } finally {
        lock.unlock();
    }
}
```

## 四、支付幂等状态机

### 4.1 支付单状态流转

```
┌─────────────┐    创建     ┌─────────────┐   支付成功   ┌─────────┐
│   CREATED   │ ──────────► │   PENDING   │ ──────────► │  PAID   │
└─────────────┘             └─────────────┘             └─────────┘
       │                           │                           │
       │                           │                           │
       │ 过期/取消                 │ 支付失败                   │ 退款
       ▼                           ▼                           ▼
┌─────────────┐             ┌─────────────┐             ┌───────────┐
│   EXPIRED   │             │   FAILED    │             │  REFUNDED │
└─────────────┘             └─────────────┘             └───────────┘
```

### 4.2 状态检查核心代码

```java
public class PayOrder {
    
    /**
     * 判断是否已支付
     * 满足以下条件视为已支付：
     * 1. 支付金额 > 0
     * 2. 状态为 PAID 或 REFUNDED
     * 3. 有渠道流水号
     * 4. 有支付成功时间
     */
    public boolean isPaid() {
        return paidAmount.compareTo(BigDecimal.ZERO) > 0
                && (orderState == PayOrderState.PAID || orderState == PayOrderState.REFUNDED)
                && channelStreamId != null
                && paySucceedTime != null;
    }
    
    /**
     * 判断是否可支付
     */
    public boolean canPay() {
        return orderState == PayOrderState.PENDING;
    }
    
    /**
     * 判断是否可退款
     */
    public boolean canRefund() {
        return isPaid() && refundAmount.compareTo(paidAmount) < 0;
    }
}
```

## 五、消息消费幂等

### 5.1 消息幂等处理流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      消息消费幂等处理流程                          │
│                                                                 │
│  消息到达                                                        │
│     │                                                           │
│     ▼                                                           │
│  提取幂等号                                                      │
│     │                                                           │
│     ▼                                                           │
│  ┌──────────────────┐                                          │
│  │  一锁：分布式锁     │                                          │
│  │  lock(identifier) │                                          │
│  └────────┬───────────┘                                          │
│           │                                                      │
│           ▼                                                      │
│  ┌──────────────────┐    已存在      ┌────────────┐              │
│  │ 二判：检查流水表   │ ───────────► │ 幂等返回    │              │
│  │ selectById(id)   │               └────────────┘              │
│  └────────┬───────────┘                                          │
│           │ 不存在                                               │
│           ▼                                                      │
│  ┌──────────────────┐    已终态      ┌────────────┐              │
│  │ 三判断：检查状态   │ ───────────► │ 幂等返回    │              │
│  │ isTerminal()     │               └────────────┘              │
│  └────────┬───────────┘                                          │
│           │ 非终态                                               │
│           ▼                                                      │
│  ┌──────────────────┐                                            │
│  │ 三更新：执行业务   │                                            │
│  │ + 记录流水        │                                            │
│  └──────────────────┘                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 消息消费者示例

```java
@RocketMQMessageListener(topic = "pay-result-topic", consumerGroup = "pay-group")
public class PayResultListener implements RocketMQListener<MessageBody> {
    
    @Autowired
    private PayApplicationService payApplicationService;
    
    @Override
    public void onMessage(MessageBody message) {
        String identifier = message.getIdentifier();
        log.info("Received pay result message, identifier={}", identifier);
        
        try {
            // 解析消息
            PaySuccessEvent event = JSON.parseObject(message.getBody(), PaySuccessEvent.class);
            
            // 执行支付成功处理（内部已包含幂等逻辑）
            boolean result = payApplicationService.paySuccess(event);
            
            if (result) {
                log.info("Pay result processed successfully, identifier={}", identifier);
            }
            
        } catch (Exception e) {
            log.error("Pay result processing failed, identifier={}", identifier, e);
            // 抛出异常，触发MQ重试
            throw e;
        }
    }
}
```

## 六、退款幂等处理

### 6.1 退款单创建（幂等）

```java
public RefundOrder create(RefundCreateRequest request) {
    // 一锁：分布式锁
    RLock lock = redissonClient.getLock("refund:create:" + request.getPayOrderId());
    lock.lock();
    
    try {
        // 二判：检查支付单是否存在且已支付
        PayOrder payOrder = payOrderMapper.selectById(request.getPayOrderId());
        if (payOrder == null || !payOrder.isPaid()) {
            throw new BusinessException("支付单不存在或未支付");
        }
        
        // 二判：幂等号检查
        RefundOrder existRefund = refundOrderMapper.selectByIdentifier(
            request.getPayOrderId(),
            request.getIdentifier(),
            request.getRefundChannel().name()
        );
        
        if (existRefund != null) {
            log.info("Refund already exists, idempotent return. identifier={}", request.getIdentifier());
            return existRefund;  // 幂等返回
        }
        
        // 三更新：创建退款单
        RefundOrder refundOrder = RefundOrder.create(request, payOrder);
        refundOrderMapper.insert(refundOrder);
        
        // 异步调用退款渠道
        asyncCallRefundChannel(refundOrder);
        
        return refundOrder;
        
    } finally {
        lock.unlock();
    }
}
```

## 七、方案总结

### 7.1 幂等控制策略对比

| 策略 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| **唯一索引** | 数据库写入 | 简单可靠 | 需要数据库支持 |
| **分布式锁** | 高并发场景 | 并发安全 | 性能开销 |
| **幂等号查询** | 消息消费 | 防重复消费 | 需要额外表 |
| **状态机检查** | 状态变更 | 逻辑严谨 | 实现复杂 |

### 7.2 本方案特点

| 特性 | 实现 |
|------|------|
| **并发安全** | 分布式锁 + 数据库唯一索引 |
| **重复识别** | 幂等号 + 状态检查 |
| **分层更新** | 预扣 → 确认 → 终态 |
| **失败重试** | MQ重试 + 幂等返回 |
| **可追溯** | 流水表记录 |

### 7.3 核心价值

1. **资金安全**：多层次防护，杜绝重复扣款
2. **系统可靠**：消息重试不影响正确性
3. **易于维护**：统一的幂等处理模式
4. **可追溯**：完整的操作流水记录

如果你在构建支付系统，不妨参考这一设计思路。

---

*本文作者：李晓阳，电子科技大学计算机科学与技术专业在读研究生，专注于 Java 开发与分布式系统设计。*
