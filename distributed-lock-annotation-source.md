---
title: 基于 AOP + 自定义注解 + Redisson 实现分布式锁
date: 2026-01-10 10:00:00
categories:
  - 架构设计
tags:
  - 分布式锁
  - Redisson
  - AOP
  - SpringBoot
  - 架构设计
  - 设计模式
  - 防刷
description: 本文介绍如何基于 AOP + 自定义注解 + Redisson 实现一套分布式锁注解框架，聚焦于框架设计思想的讲解，并展示其在典型业务场景中的应用。
---

> 写在前面：本文介绍如何基于 AOP + 自定义注解 + Redisson 实现一套分布式锁注解框架，聚焦于框架设计思想的讲解，并展示其在典型业务场景中的应用。

<!-- more -->

## 一、为什么需要分布式锁？

在分布式系统中，多个服务实例可能同时操作同一份数据，如果没有同步机制，就会产生并发问题。典型场景包括：

| 场景 | 问题描述 |
|------|----------|
| **用户注册** | 同一手机号被多个请求同时注册，导致重复用户 |
| **订单创建** | 超卖问题：同一商品被多个用户同时抢到 |
| **库存扣减** | 库存超扣：实际库存为负数 |
| **短信发送** | 接口被刷：同一手机号被恶意高频请求 |
| **支付回调** | 重复处理：同一订单被多次回调 |

传统的 `synchronized` 或 `ReentrantLock` 只能解决单 JVM 内的并发问题，无法跨进程、跨节点工作。

## 二、技术方案设计

### 2.1 核心设计思想

分布式锁框架的设计有几个关键考量点：

**1. 注解 vs 配置：选择注解的优势**

对比配置文件方式，注解具有：
- **侵入性低**：只需在方法上加注解，无需改动业务逻辑
- **内聚性强**：锁逻辑与业务代码在同一个位置，便于维护
- **可读性高**：开发者一眼就能看出哪些方法需要加锁

**2. 静态 key vs 动态 key：为什么需要 SPEL 表达式**

锁的本质是"对什么加锁"。如果是固定值（如某个全局资源），可以用静态 key。但大多数场景下，锁 key 需要根据参数动态生成——比如用户注册时，锁 key 应该是用户手机号。

如果用配置文件，你需要额外提供一个 key 解析器；而注解内嵌 SPEL 表达式，则可以直接从方法参数中提取。

**3. 等待策略：.block() vs .tryLock()**

有两种获取锁的策略：
- **阻塞等待**（`.lock()`）：一直等到获取锁为止，适用于对一致性要求极高的场景
- **非阻塞等待**（`.tryLock()`）：尝试获取，失败则立即返回，适用于可以接受"抢不到就放弃"的场景

好的框架应该同时支持两种模式。

### 2.2 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Controller 层                              │
│                  AuthController.login()                         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Service 层                                   │
│                    UserService.register()                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
        ▼                                       ▼
┌───────────────────┐               ┌───────────────────┐
│  RateLimiter      │               │ @DistributeLock    │
│  (滑动窗口限流)    │               │  (分布式锁)         │
│                   │               │                   │
│ tryAcquire()      │               │ before: 加锁       │
│                   │               │ proceed()          │
│ 防止高频请求       │               │ after: 解锁        │
└───────────────────┘               └───────────────────┘
```

## 三、核心实现

### 3.1 自定义注解的设计

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface DistributeLock {

    /**
     * 锁的场景前缀
     * 用于区分不同业务，例如 "USER_REGISTER"、"SEND_SMS"
     */
    String scene();

    /**
     * 静态锁 key
     * 适用于锁 key 不需要动态变化的场景
     */
    String key() default "NONE";

    /**
     * SPEL 动态表达式
     * 支持从方法参数中动态提取锁 key
     * 示例：
     *   #id          -> 方法参数名为 id
     *   #user.id     -> 参数对象 user 的 id 属性
     */
    String keyExpression() default "NONE";

    /**
     * 锁超时时间（毫秒）
     * 默认 -1 表示不设置超时（由 Redisson 自动续期）
     */
    int expireTime() default -1;

    /**
     * 等待时长（毫秒）
     * 默认 Integer.MAX_VALUE 表示一直等待
     */
    int waitTime() default Integer.MAX_VALUE;
}
```

**设计亮点说明**：

1. **支持 SPEL 表达式**：锁 key 可以动态从方法参数中提取，无需硬编码
2. **灵活的加锁策略**：可配置是否等待、超时时间、自动续期
3. **场景区分**：通过 `scene` 前缀区分不同业务，避免 key 冲突

### 3.2 分布式锁切面的设计

```java
@Aspect
@Component
@Order(Integer.MIN_VALUE + 1)
public class DistributeLockAspect {

    private final RedissonClient redissonClient;

    public DistributeLockAspect(RedissonClient redissonClient) {
        this.redissonClient = redissonClient;
    }

    @Around("@annotation(DistributeLock)")
    public Object process(ProceedingJoinPoint pjp) throws Exception {
        Method method = ((MethodSignature) pjp.getSignature()).getMethod();
        DistributeLock distributeLock = method.getAnnotation(DistributeLock.class);

        // 1. 解析锁 key（静态或动态）
        String key = resolveLockKey(pjp, method, distributeLock);
        String lockKey = distributeLock.scene() + "#" + key;

        // 2. 构建锁
        RLock rLock = redissonClient.getLock(lockKey);

        try {
            // 3. 尝试加锁
            boolean lockResult = tryAcquireLock(rLock, distributeLock);

            if (!lockResult) {
                throw new DistributeLockException("acquire lock failed... key : " + lockKey);
            }

            // 4. 执行目标方法
            return pjp.proceed();

        } finally {
            // 5. 释放锁
            if (rLock.isHeldByCurrentThread()) {
                rLock.unlock();
            }
        }
    }

    private String resolveLockKey(ProceedingJoinPoint pjp, Method method, DistributeLock distributeLock) {
        String key = distributeLock.key();
        if (!"NONE".equals(key)) {
            return key;  // 静态 key
        }

        // 动态 key：使用 SPEL 表达式解析
        String keyExpression = distributeLock.keyExpression();
        if ("NONE".equals(keyExpression)) {
            throw new DistributeLockException("no lock key found...");
        }

        SpelExpressionParser parser = new SpelExpressionParser();
        Expression expression = parser.parseExpression(keyExpression);
        EvaluationContext context = new StandardEvaluationContext();

        Object[] args = pjp.getArgs();
        String[] parameterNames = new StandardReflectionParameterNameDiscoverer().getParameterNames(method);

        if (parameterNames != null) {
            for (int i = 0; i < parameterNames.length; i++) {
                context.setVariable(parameterNames[i], args[i]);
            }
        }

        return String.valueOf(expression.getValue(context));
    }

    private boolean tryAcquireLock(RLock rLock, DistributeLock distributeLock) throws InterruptedException {
        int expireTime = distributeLock.expireTime();
        int waitTime = distributeLock.waitTime();

        if (waitTime == Integer.MAX_VALUE) {
            // 阻塞模式
            rLock.lock(expireTime == -1 ? -1 : expireTime, TimeUnit.MILLISECONDS);
            return true;
        } else {
            // 非阻塞模式
            return rLock.tryLock(waitTime, expireTime, TimeUnit.MILLISECONDS);
        }
    }
}
```

**切面设计要点**：

1. **切点选择**：使用 `@Around` 环绕通知，可以在方法执行前后都插入逻辑
2. **执行顺序**：设置高优先级（`Integer.MIN_VALUE`），确保在事务等之前执行
3. **异常处理**：使用 try-finally 确保锁一定被释放
4. **SPEL 解析**：通过反射获取方法参数名，将参数绑定到表达式上下文

## 四、滑动窗口限流 — 短信防刷

### 4.1 问题分析

短信验证码接口是接口被刷的重灾区。恶意用户可能使用脚本高频请求：

- **成本损失**：每条短信都需要付费
- **用户体验**：正常用户收不到短信
- **业务风险**：可能被用于诈骗

### 4.2 双重保险机制

短信防刷需要两道防线：

| 防线 | 作用 | 特点 |
|------|------|------|
| **限流器** | 限制请求频率 | 无状态，只关心"能不能通过" |
| **分布式锁** | 防止并发重复 | 有状态，保证同一时刻只有一个请求在处理 |

```
请求 -> [限流器检查] -> [分布式锁] -> 发送短信
              │              │
              ↓              ↓
          通过/拒绝      加锁成功/失败
```

**为什么需要两道防线？**

限流器是无状态的，它只能保证"时间窗口内的请求次数"，但无法防止并发。比如：
- 限流规则：每60秒1次
- 恶意用户：在59秒时发送100个并发请求

限流器无法识别这是并发请求，但分布式锁可以。

### 4.3 滑动窗口限流器

基于 Redis 的滑动窗口实现：

```java
public class SlidingWindowRateLimiter implements RateLimiter {

    private final RedissonClient redissonClient;

    public SlidingWindowRateLimiter(RedissonClient redissonClient) {
        this.redissonClient = redissonClient;
    }

    @Override
    public Boolean tryAcquire(String key, int limit, int windowSize) {
        RRateLimiter rateLimiter = redissonClient.getRateLimiter("limit:" + key);

        if (!rateLimiter.isExists()) {
            rateLimiter.trySetRate(
                RateType.OVERALL,  // 所有请求共享令牌桶
                limit,             // 令牌数量
                windowSize,        // 时间窗口
                RateIntervalUnit.SECONDS
            );
        }

        return rateLimiter.tryAcquire();
    }
}
```

## 五、业务应用场景

### 5.1 注解使用方式

```java
@Service
public class UserService {

    // 方式一：使用 SPEL 表达式（推荐）
    @DistributeLock(keyExpression = "#telephone", scene = "USER_REGISTER")
    public void register(String telephone, String inviteCode) {
        // 业务逻辑...
    }

    // 方式二：使用静态 key
    @DistributeLock(key = "GLOBAL_CONFIG", scene = "SYSTEM")
    public void updateGlobalConfig() {
        // 业务逻辑...
    }

    // 方式三：非阻塞模式（等待3秒，获取不到就放弃）
    @DistributeLock(
        keyExpression = "#resourceId",
        scene = "RESOURCE_LOCK",
        waitTime = 3000
    )
    public void limitedOperate(String resourceId) {
        // 业务逻辑...
    }
}
```

### 5.2 典型业务场景

| 场景 | 锁 key | 等待策略 | 说明 |
|------|--------|----------|------|
| 用户注册 | `#telephone` | 阻塞 | 必须注册成功，不可放弃 |
| 订单创建 | `#orderId` | 阻塞 | 必须处理，不可重复 |
| 库存扣减 | `#skuId` | 非阻塞 | 库存不足时放弃，抢购场景 |
| 短信发送 | `#phoneNumber` | 阻塞 | 防并发重复发送 |
| 回调处理 | `#orderId` | 非阻塞 | 重复回调直接跳过 |

## 六、框架总结

| 特性 | 实现 |
|------|------|
| **分布式同步** | Redisson RLock（基于 Redis） |
| **注解定义** | `@DistributeLock` + SPEL 表达式 |
| **AOP 拦截** | `@Around` 切面统一处理 |
| **自动续期** | 默认开启（expireTime = -1） |
| **等待策略** | 可配置阻塞或非阻塞 |
| **防刷限流** | 滑动窗口令牌桶算法 |
| **短信防刷** | 限流 + 分布式锁双重保险 |

## 七、方案优势

1. **代码简洁**：只需一行注解即可添加分布式锁
2. **复用性强**：统一的锁策略，减少重复代码
3. **易于维护**：锁逻辑集中管理，便于监控和调优
4. **防刷友好**：结合限流实现多层次防护
5. **灵活配置**：支持多种加锁策略，适应不同业务场景

如果你也在构建高并发系统，不妨参考这一设计思路。

---

*本文作者：李晓阳，电子科技大学计算机科学与技术专业在读研究生，专注于 Java 开发与分布式系统设计。*
