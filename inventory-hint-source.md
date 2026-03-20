---
title: 基于InventoryHint实现库存的热点扣减
date: 2026-02-13 10:00:00
categories:
  - 架构设计
tags:
  - 库存系统
  - 高并发
  - 热点扣减
  - 设计模式
  - 架构设计
description: 本文介绍如何通过InventoryHint实现库存的热点扣减，解决高并发场景下的库存竞争问题，提升系统的吞吐量和稳定性。
---

> 写在前面：在电商系统中，库存扣减是最核心也是最敏感的操作之一。尤其是秒杀、抢购等热点场景下，同一个SKU的库存会被大量并发请求同时扣减，如果处理不当，极易引发超卖、数据库压力过高等问题。本文介绍一种基于 InventoryHint 的库存热点扣减方案，兼顾性能与可靠性。

<!-- more -->

## 一、库存扣减的核心挑战

### 1.1 热点场景的特点

**什么是热点库存？**：指那些在特定时间窗口内被大量并发访问的商品库存。比如：
- 秒杀商品：库存有限，瞬时大量抢购
- 爆款商品：库存充足，但访问量巨大
- 限时促销：活动期间访问量激增

```
┌─────────────────────────────────────────────────────────────────┐
│                    热点库存场景示意                                 │
│                                                                 │
│                        秒杀活动开始                                │
│                            ▼                                     │
│         ┌───────────────────────────────────────┐               │
│         │         10:00 万人抢购 1000 件         │               │
│         └───────────────┬───────────────────────┘               │
│                         │                                        │
│     ┌──────────────────┼──────────────────┐                    │
│     │                  │                  │                    │
│     ▼                  ▼                  ▼                     │
│  ┌──────┐          ┌──────┐          ┌──────┐                │
│  │请求1 │          │请求2 │          │请求3 │                │
│  │-库存 │          │-库存 │          │-库存 │                │
│  └──────┘          └──────┘          └──────┘                │
│     ...               ...               ...                    │
│  ┌──────┐                                                   │
│  │请求N │                                                   │
│  │-库存 │                                                   │
│  └──────┘                                                   │
│                                                                 │
│  问题：库存成为瓶颈，所有请求都在竞争同一把锁                      │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 传统方案的问题

| 方案 | 实现方式 | 问题 |
|------|----------|------|
| **数据库乐观锁** | 版本号/CAS | 冲突率高，失败重试多 |
| **数据库悲观锁** | SELECT FOR UPDATE | 锁时间长，性能差 |
| **Redis原子操作** | DECR/Lua脚本 | 数据一致性难以保证 |
| **消息队列削峰** | 异步扣减 | 时效性差，体验不好 |

**核心问题**：库存扣减需要**强一致性**（不能超卖），但高并发场景下**强一致性**和**高性能**往往矛盾。

## 二、InventoryHint 的设计思想

### 2.1 问题的本质

**设计思想**：库存热点扣减的本质问题是**写冲突**——大量并发请求同时尝试扣减同一个 SKU 的库存。解决思路有两个：

1. **减少写冲突**：将库存打散到多个桶，分散压力
2. **减少锁竞争**：用乐观锁替代悲观锁，缩短锁时间

```
┌─────────────────────────────────────────────────────────────────┐
│                    库存扣减的两种思路                              │
│                                                                 │
│  思路一：减少写冲突（桶化）                                        │
│  ┌─────────────────────────────────────────┐                   │
│  │  原始：    库存 = 100                   │                   │
│  │  桶化后：  库存1 = 50, 库存2 = 50       │                   │
│  │           库存3 = 30, 库存4 = 30        │                   │
│  │                                          │                   │
│  │  请求可以分散到不同的桶，减少竞争           │                   │
│  └─────────────────────────────────────────┘                   │
│                                                                 │
│  思路二：减少锁竞争（乐观锁）                                       │
│  ┌─────────────────────────────────────────┐                   │
│  │  原始：    SELECT → 锁定 → UPDATE        │                   │
│  │  乐观锁：  UPDATE WHERE version = old    │                   │
│  │                                          │                   │
│  │  不用锁定整行，减少锁等待                  │                   │
│  └─────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 InventoryHint 的核心设计

**设计思想**：InventoryHint 是库存扣减的" hint"（提示），它封装了扣减所需的所有上下文信息。通过这个 Hint，我们可以：
1. **携带扣减策略**：是乐观锁还是悲观锁
2. **携带扣减上下文**：扣减数量、原库存、版本号等
3. **携带回滚信息**：扣减失败时的回滚策略

```java
/**
 * 库存扣减提示器
 * 
 * 设计要点：
 * 1. 封装扣减上下文 - 将扣减所需的所有信息封装在一起
 *    这样做的好处：调用方只需传递一个 Hint，内部自动处理复杂逻辑
 * 2. 策略模式 - 不同扣减策略（乐观/悲观）实现不同策略
 * 3. 可组合 - Hint 可以叠加，支持链式调用
 * 
 * 为什么叫 Hint？
 * 因为它提供的是"扣减的提示"而非"扣减本身"
 * 调用方描述"想要怎么扣"，而不是"直接扣"
 */
public class InventoryHint {
    
    /**
     * SKU ID
     */
    private String skuId;
    
    /**
     * 扣减数量
     */
    private Integer quantity;
    
    /**
     * 扣减策略
     * - OPTIMISTIC: 乐观锁扣减（推荐）
     * - PESSIMISTIC: 悲观锁扣减（用于高竞争场景）
     * - FAST: 快速扣减（不保证一致性，用于幂等场景）
     */
    private InventoryStrategy strategy = InventoryStrategy.OPTIMISTIC;
    
    /**
     * 扣减类型
     * - NORMAL: 普通扣减
     * - FREEZE: 冻结库存
     * - PREEMPT: 预占库存
     */
    private InventoryType type = InventoryType.NORMAL;
    
    /**
     * 库存版本（用于乐观锁）
     */
    private Long version;
    
    /**
     * 超时时间（毫秒）
     * 用于控制悲观锁的等待时间
     */
    private Long timeoutMs = 3000L;
    
    /**
     * 链式调用的核心：返回 this
     * 使得可以这样使用：
     *   hint.withSkuId("SKU001").withQuantity(1).withStrategy(OPTIMISTIC)
     */
    public InventoryHint withSkuId(String skuId) {
        this.skuId = skuId;
        return this;
    }
    
    public InventoryHint withQuantity(Integer quantity) {
        this.quantity = quantity;
        return this;
    }
    
    public InventoryHint withStrategy(InventoryStrategy strategy) {
        this.strategy = strategy;
        return this;
    }
    
    public InventoryHint withType(InventoryType type) {
        this.type = type;
        return this;
    }
    
    public InventoryHint withVersion(Long version) {
        this.version = version;
        return this;
    }
    
    public InventoryHint withTimeout(Long timeoutMs) {
        this.timeoutMs = timeoutMs;
        return this;
    }
    
    // Getters...
}
```

### 2.3 策略枚举的设计

**设计思想**：通过策略枚举定义不同的扣减方式，让调用方可以选择适合自己的策略。这种设计既保证了灵活性，又避免了过多的 if-else 判断。

```java
/**
 * 库存扣减策略枚举
 * 
 * 设计要点：
 * 1. 策略枚举 - 清晰定义每种策略的用途
 * 2. 默认值设置 - OPTIMISTIC 作为默认策略，平衡性能和安全
 * 3. 策略说明 - 每个枚举值都有清晰的注释
 */
public enum InventoryStrategy {
    
    /**
     * 乐观锁扣减（推荐）
     * 适用场景：库存充足、竞争不激烈
     * 优点：不阻塞，吞吐量大
     * 缺点：可能需要重试
     */
    OPTIMISTIC("乐观锁", "高吞吐量，可能重试"),
    
    /**
     * 悲观锁扣减
     * 适用场景：库存紧张、竞争激烈
     * 优点：保证扣减成功
     * 缺点：可能阻塞其他请求
     */
    PESSIMISTIC("悲观锁", "强一致性，可能阻塞"),
    
    /**
     * 快速扣减
     * 适用场景：不要求强一致性的场景（如幂等扣减）
     * 优点：性能最高
     * 缺点：不保证一定能扣减成功
     */
    FAST("快速扣减", "最高性能，不保证一致性");
    
    private final String name;
    private final String description;
    
    InventoryStrategy(String name, String description) {
        this.name = name;
        this.description = description;
    }
}
```

## 三、热点扣减的实现

### 3.1 核心服务接口

**设计思想**：接口设计遵循"命令模式"的思想——调用方通过 Hint 描述操作，服务端执行。接口只关心"做什么"，不关心"怎么做"。具体实现由策略类负责。

```java
/**
 * 库存服务接口
 * 
 * 设计要点：
 * 1. 返回 InventoryResult - 包含扣减结果和详细信息
 *    不同于简单的 boolean，Result 可以携带错误信息、成功数量等
 * 2. 参数为 InventoryHint - 调用方通过 Hint 描述扣减需求
 *    这种设计让接口保持简洁，复杂性由 Hint 和策略类处理
 * 3. 支持批量扣减 - 一个方法处理单扣和批量扣减
 */
public interface InventoryService {
    
    /**
     * 扣减库存
     * 
     * @param hint 库存扣减提示器
     * @return 扣减结果
     */
    InventoryResult deduct(InventoryHint hint);
    
    /**
     * 批量扣减库存
     * 原子操作：要么全部成功，要么全部失败
     */
    InventoryResult batchDeduct(List<InventoryHint> hints);
    
    /**
     * 回滚库存
     * 用于扣减失败或业务撤销时回滚
     */
    InventoryResult rollback(InventoryHint hint);
    
    /**
     * 查询库存
     */
    InventoryInfo getInventory(String skuId);
}
```

### 3.2 热点判断器

**设计思想**：通过热点判断器自动识别热点 SKU。当检测到某个 SKU 成为热点时，自动切换到热点扣减模式。这种"自动发现、自动切换"的机制让系统更加智能。

```java
/**
 * 库存热点判断器
 * 
 * 设计要点：
 * 1. 自动识别热点 - 基于访问频率和并发度判断
 * 2. 动态切换 - 热点状态实时更新
 * 3. 降级策略 - 热点时自动降级到更安全的扣减策略
 * 
 * 为什么需要热点判断？
 * 因为热点是动态的——一个 SKU 可能平时不是热点，但活动时变成热点
 * 静态配置无法适应这种变化
 */
@Component
public class InventoryHotspotDetector {
    
    /**
     * 热点判断的核心指标
     */
    private static final int HOT_THRESHOLD_QPS = 100;      // QPS 阈值
    private static final int HOT_THRESHOLD_CONCURRENCY = 50; // 并发数阈值
    
    @Autowired
    private InventoryMetricsService metricsService;
    
    /**
     * 判断是否为热点 SKU
     * 
     * 判断逻辑：
     * 1. 采集 QPS 和并发度指标
     * 2. 任一指标超过阈值即为热点
     * 3. 热点状态会缓存一段时间，避免频繁切换
     */
    public boolean isHotspot(String skuId) {
        // 1. 先检查缓存（热点判断结果会被缓存）
        HotspotStatus cached = getCachedStatus(skuId);
        if (cached != null) {
            return cached.isHot();
        }
        
        // 2. 采集实时指标
        InventoryMetrics metrics = metricsService.getMetrics(skuId);
        
        // 3. 判断是否热点
        boolean isHot = metrics.getQps() > HOT_THRESHOLD_QPS
                || metrics.getConcurrency() > HOT_THRESHOLD_CONCURRENCY;
        
        // 4. 缓存判断结果（热点状态缓存 30 秒）
        cacheStatus(skuId, new HotspotStatus(isHot), 30L);
        
        return isHot;
    }
    
    /**
     * 获取热点扣减策略
     * 热点时自动切换到更安全的策略
     */
    public InventoryStrategy getHotspotStrategy(String skuId) {
        if (isHotspot(skuId)) {
            // 热点 SKU 使用悲观锁，保证强一致性
            return InventoryStrategy.PESSIMISTIC;
        }
        // 非热点使用乐观锁，追求高吞吐
        return InventoryStrategy.OPTIMISTIC;
    }
}
```

### 3.3 乐观锁扣减实现

**设计思想**：乐观锁扣减的核心是"先更新，再检查"。通过版本号控制并发，只有版本号匹配时才能更新成功。如果失败，说明有并发冲突，需要重试。

```java
/**
 * 乐观锁库存扣减策略
 * 
 * 设计要点：
 * 1. 不阻塞 - 乐观锁的核心优势
 * 2. 重试机制 - 冲突时自动重试
 * 3. 退避策略 - 避免重试时再次冲突
 * 
 * 为什么乐观锁适合非热点场景？
 * 因为在竞争不激烈时，乐观锁几乎不会冲突，性能最好
 * 只有热点场景才需要悲观锁
 */
@Service
public class OptimisticInventoryStrategy implements InventoryStrategyHandler {
    
    @Autowired
    private InventoryDao inventoryDao;
    
    @Autowired
    private MetricsService metricsService;
    
    /**
     * 乐观锁扣减的核心 SQL
     * 
     * 关键点：WHERE 条件包含当前库存和版本号
     * - 只有库存足够且版本号匹配时才能更新成功
     * - 更新成功说明扣减成功
     * - 更新为 0 行说明条件不满足（库存不足或版本冲突）
     */
    @Override
    public InventoryResult deduct(InventoryHint hint) {
        int maxRetries = 3;  // 最多重试 3 次
        int retryCount = 0;
        
        while (retryCount < maxRetries) {
            // 1. 获取当前库存信息（包含版本号）
            Inventory inventory = inventoryDao.selectForUpdate(hint.getSkuId());
            
            if (inventory == null) {
                return InventoryResult.fail("SKU不存在");
            }
            
            // 2. 检查库存是否足够
            if (inventory.getAvailable() < hint.getQuantity()) {
                return InventoryResult.fail("库存不足，当前："
                    + inventory.getAvailable() + "，需要：" + hint.getQuantity());
            }
            
            // 3. 执行乐观锁扣减
            //    WHERE available >= #{quantity} AND version = #{version}
            //    UPDATE available = available - #{quantity}, version = version + 1
            int affectedRows = inventoryDao.optimisticDeduct(
                hint.getSkuId(),
                hint.getQuantity(),
                inventory.getVersion()  // 传入当前版本号
            );
            
            // 4. 判断扣减结果
            if (affectedRows > 0) {
                // 扣减成功
                metricsService.recordDeductSuccess(hint.getSkuId());
                return InventoryResult.success(
                    hint.getSkuId(),
                    hint.getQuantity(),
                    inventory.getAvailable() - hint.getQuantity()
                );
            }
            
            // 5. 扣减失败（版本号冲突），重试
            retryCount++;
            metricsService.recordDeductConflict(hint.getSkuId());
            
            // 退避策略：避免重试时再次冲突
            // 退避时间 = 重试次数 * 基础时间（5ms）
            try {
                Thread.sleep(retryCount * 5L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return InventoryResult.fail("扣减被中断");
            }
        }
        
        // 超过最大重试次数
        return InventoryResult.fail("扣减失败，已达到最大重试次数");
    }
}
```

### 3.4 悲观锁扣减实现

**设计思想**：悲观锁扣减的核心是"先锁定，再操作"。通过 SELECT FOR UPDATE 锁定行，确保同一时刻只有一个请求能操作库存。虽然会阻塞其他请求，但能保证强一致性。

```java
/**
 * 悲观锁库存扣减策略
 * 
 * 设计要点：
 * 1. 强一致性 - 通过行锁保证
 * 2. 超时控制 - 防止长时间等待
 * 3. 死锁预防 - 按固定顺序加锁
 * 
 * 为什么热点场景需要悲观锁？
 * 因为热点场景下乐观锁冲突率太高，重试次数太多反而更慢
 * 悲观锁虽然会阻塞，但能一次成功
 */
@Service
public class PessimisticInventoryStrategy implements InventoryStrategyHandler {
    
    @Autowired
    private InventoryDao inventoryDao;
    
    @Autowired
    private MetricsService metricsService;
    
    /**
     * 悲观锁扣减
     * 
     * 关键点：SELECT ... FOR UPDATE
     * - 获取行级写锁
     * - 其他事务必须等待锁释放
     * - 锁在事务提交/回滚时释放
     */
    @Override
    public InventoryResult deduct(InventoryHint hint) {
        // 1. 设置超时时间（防止死锁）
        long startTime = System.currentTimeMillis();
        long timeout = hint.getTimeoutMs();
        
        while (System.currentTimeMillis() - startTime < timeout) {
            try {
                // 2. 加悲观锁查询
                // 注意：必须在事务中执行
                Inventory inventory = inventoryDao.selectWithLock(hint.getSkuId());
                
                if (inventory == null) {
                    return InventoryResult.fail("SKU不存在");
                }
                
                // 3. 检查库存
                if (inventory.getAvailable() < hint.getQuantity()) {
                    return InventoryResult.fail("库存不足");
                }
                
                // 4. 执行扣减（此时已持有锁，不会有并发问题）
                inventoryDao.deduct(
                    hint.getSkuId(),
                    hint.getQuantity()
                );
                
                metricsService.recordDeductSuccess(hint.getSkuId());
                
                return InventoryResult.success(
                    hint.getSkuId(),
                    hint.getQuantity(),
                    inventory.getAvailable() - hint.getQuantity()
                );
                
            } catch (LockAcquisitionException e) {
                // 获取锁失败，等待后重试
                try {
                    Thread.sleep(10L);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return InventoryResult.fail("扣减被中断");
                }
            }
        }
        
        // 超时
        return InventoryResult.fail("扣减超时");
    }
}
```

### 3.5 策略选择器

**设计思想**：策略选择器根据热点状态自动选择合适的扣减策略。这种"自动切换"的机制让系统能够自适应不同的负载场景。

```java
/**
 * 库存扣减策略选择器
 * 
 * 设计要点：
 * 1. 策略选择自动化 - 根据热点状态自动选择
 * 2. 策略可配置 - 支持手动指定策略
 * 3. 降级处理 - 策略执行失败时自动降级
 * 
 * 策略选择逻辑：
 * - 热点 SKU → 悲观锁
 * - 非热点 SKU → 乐观锁
 * - 强制指定 → 按指定策略
 */
@Component
public class InventoryStrategySelector {
    
    @Autowired
    private InventoryHotspotDetector hotspotDetector;
    
    @Autowired
    private OptimisticInventoryStrategy optimisticStrategy;
    
    @Autowired
    private PessimisticInventoryStrategy pessimisticStrategy;
    
    /**
     * 获取扣减策略处理器
     * 
     * 选择逻辑：
     * 1. 如果 Hint 中强制指定了策略 → 使用指定策略
     * 2. 如果是热点 SKU → 使用悲观锁
     * 3. 其他情况 → 使用乐观锁
     */
    public InventoryStrategyHandler select(InventoryHint hint) {
        // 1. 强制指定策略
        if (hint.getStrategy() != null) {
            return getHandler(hint.getStrategy());
        }
        
        // 2. 热点检测
        String skuId = hint.getSkuId();
        if (hotspotDetector.isHotspot(skuId)) {
            // 热点 SKU 自动切换到悲观锁
            return pessimisticStrategy;
        }
        
        // 3. 默认使用乐观锁
        return optimisticStrategy;
    }
    
    /**
     * 获取策略处理器
     */
    private InventoryStrategyHandler getHandler(InventoryStrategy strategy) {
        switch (strategy) {
            case OPTIMISTIC:
                return optimisticStrategy;
            case PESSIMISTIC:
                return pessimisticStrategy;
            default:
                throw new IllegalArgumentException("不支持的策略：" + strategy);
        }
    }
    
    /**
     * 策略降级
     * 当主策略失败时，自动尝试备选策略
     */
    public InventoryResult deductWithFallback(InventoryHint hint) {
        InventoryStrategyHandler primaryStrategy = select(hint);
        InventoryResult result = primaryStrategy.deduct(hint);
        
        // 如果主策略成功，直接返回
        if (result.isSuccess()) {
            return result;
        }
        
        // 如果是库存不足，不需要降级
        if (result.isStockInsufficient()) {
            return result;
        }
        
        // 降级到悲观锁（如果主策略不是悲观锁）
        if (hint.getStrategy() != InventoryStrategy.PESSIMISTIC) {
            hint.setStrategy(InventoryStrategy.PESSIMISTIC);
            return pessimisticStrategy.deduct(hint);
        }
        
        return result;
    }
}
```

## 四、InventoryHint 的使用方式

### 4.1 基础使用

**设计思想**：简洁的 API 设计让调用方无需关心底层实现。通过链式调用，可以流畅地描述扣减需求。

```java
/**
 * 订单服务中使用 InventoryHint
 * 
 * 设计要点：
 * 1. 链式调用 - 流畅的 API 设计
 * 2. 默认值 - 大部分参数可以省略
 * 3. 统一入口 - 扣减逻辑集中在 InventoryService
 * 
 * 调用示例：
 *   inventoryService.deduct(
 *       new InventoryHint()
 *           .withSkuId("SKU001")
 *           .withQuantity(1)
 *           .withType(InventoryType.NORMAL)
 *   );
 */
@Service
public class OrderService {
    
    @Autowired
    private InventoryService inventoryService;
    
    public void createOrder(CreateOrderRequest request) {
        // 构建扣减 Hint
        InventoryHint hint = new InventoryHint()
            .withSkuId(request.getSkuId())
            .withQuantity(request.getQuantity())
            .withType(InventoryType.NORMAL);  // 普通扣减
        
        // 执行扣减
        InventoryResult result = inventoryService.deduct(hint);
        
        if (!result.isSuccess()) {
            throw new BusinessException(result.getMessage());
        }
        
        // 后续业务逻辑...
    }
}
```

### 4.2 热点场景使用

**设计思想**：热点场景下，系统会自动选择更安全的策略。调用方无需额外处理，只需描述业务需求。

```java
/**
 * 秒杀服务中使用 InventoryHint
 * 
 * 设计要点：
 * 1. 自动热点检测 - 系统自动识别热点 SKU
 * 2. 自动策略切换 - 热点时自动使用悲观锁
 * 3. 降级处理 - 乐观锁失败时自动降级
 * 
 * 热点场景的优势：
 * - 高峰期自动切换到悲观锁，保证强一致性
 * - 低峰期使用乐观锁，追求高吞吐
 * - 系统自动适应，无需人工干预
 */
@Service
public class SeckillService {
    
    @Autowired
    private InventoryService inventoryService;
    
    @Autowired
    private InventoryStrategySelector strategySelector;
    
    /**
     * 秒杀扣减
     * 
     * 流程：
     * 1. 构建扣减 Hint
     * 2. 系统自动判断是否为热点
     * 3. 选择合适的策略执行
     * 4. 如果乐观锁失败，自动降级到悲观锁
     */
    public void seckill(SeckillRequest request) {
        InventoryHint hint = new InventoryHint()
            .withSkuId(request.getSkuId())
            .withQuantity(1)  // 秒杀通常一次只能买一件
            .withType(InventoryType.PREEMPT);  // 预占库存
        
        // 使用降级策略：乐观锁 → 悲观锁
        InventoryResult result = strategySelector.deductWithFallback(hint);
        
        if (!result.isSuccess()) {
            log.warn("秒杀扣减失败: skuId={}, reason={}",
                request.getSkuId(), result.getMessage());
            throw new BusinessException("库存不足");
        }
        
        log.info("秒杀扣减成功: skuId={}, remaining={}",
            request.getSkuId(), result.getRemaining());
    }
}
```

### 4.3 批量扣减

**设计思想**：批量扣减需要保证原子性——要么全部成功，要么全部失败。通过事务管理，确保数据一致性。

```java
/**
 * 购物车结算时批量扣减
 * 
 * 设计要点：
 * 1. 原子性保证 - 批量操作要么全成功，要么全失败
 * 2. 预检查机制 - 先检查所有 SKU 的库存，再执行扣减
 * 3. 失败回滚 - 任何一个失败，全部回滚
 */
@Service
public class CartService {
    
    @Autowired
    private InventoryService inventoryService;
    
    /**
     * 批量扣减
     */
    public void settleCart(SettleCartRequest request) {
        List<CartItem> items = request.getItems();
        
        // 1. 构建批量 Hint
        List<InventoryHint> hints = items.stream()
            .map(item -> new InventoryHint()
                .withSkuId(item.getSkuId())
                .withQuantity(item.getQuantity())
                .withType(InventoryType.NORMAL))
            .collect(Collectors.toList());
        
        // 2. 执行批量扣减（原子操作）
        InventoryResult result = inventoryService.batchDeduct(hints);
        
        if (!result.isSuccess()) {
            // 批量失败，需要回滚已扣减的库存
            throw new BusinessException("库存不足：" + result.getMessage());
        }
        
        // 3. 创建订单...
    }
}
```

## 五、方案总结

### 5.1 核心设计思想

```
┌─────────────────────────────────────────────────────────────────┐
│                    InventoryHint 核心设计思想                      │
│                                                                 │
│  1. 封装扣减上下文                                              │
│     ┌─────────────────────────────────────────────────────┐    │
│     │  InventoryHint 封装了扣减所需的所有信息               │    │
│     │  - SKU ID        - 扣减数量                         │    │
│     │  - 扣减策略      - 扣减类型                         │    │
│     │  - 版本号        - 超时时间                         │    │
│     └─────────────────────────────────────────────────────┘    │
│                              │                                  │
│                              ▼                                  │
│  2. 策略模式处理差异                                             │
│     ┌─────────────────────────────────────────────────────┐    │
│     │  OptimisticStrategy  │  PessimisticStrategy         │    │
│     │  乐观锁扣减         │  悲观锁扣减                    │    │
│     │  高吞吐，可能重试   │  强一致，可能阻塞              │    │
│     └─────────────────────────────────────────────────────┘    │
│                              │                                  │
│                              ▼                                  │
│  3. 热点自动感知                                                │
│     ┌─────────────────────────────────────────────────────┐    │
│     │  HotspotDetector                                     │    │
│     │  - 监控 QPS 和并发度                                 │    │
│     │  - 自动切换策略                                       │    │
│     │  - 热点时使用悲观锁，非热点使用乐观锁                  │    │
│     └─────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 方案对比

| 特性 | 传统方案 | InventoryHint 方案 |
|------|----------|-------------------|
| **扣减方式** | 固定 | 可配置 |
| **热点处理** | 手动切换 | 自动感知 |
| **策略选择** | 硬编码 | 自动选择 |
| **降级处理** | 无 | 自动降级 |
| **扩展性** | 低 | 高 |
| **性能** | 一般 | 自适应 |

### 5.3 适用场景

| 场景 | 推荐策略 | 原因 |
|------|----------|------|
| **普通电商** | 乐观锁 | 库存充足，竞争不激烈 |
| **秒杀抢购** | 悲观锁 + 降级 | 库存紧张，竞争激烈 |
| **预售活动** | 预占模式 | 先锁库存，后支付 |
| **限时促销** | 自动切换 | 根据热点动态调整 |

如果你也在设计高并发库存系统，希望这些设计思路对你有所启发。

---

*本文作者：李晓阳，电子科技大学计算机科学与技术专业在读研究生，专注于 Java 开发与分布式系统设计。*
