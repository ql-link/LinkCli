# MCPSTAT-1-L2 对话级 MCP 调用采集与统计验收契约

Feature: 第三方 Agent 的对话级 MCP 调用采集与统计

  Background:
    Given LinkCli 已有一个审核通过、健康且可调用的 MCP 工具
    And 调用方持有有效的平台调用凭据
    And L2 可靠采集与轮次归集任务已启用

  # M3，tests/collection-context.test.ts、tests/mcp-protocol.integration.test.ts
  Scenario: 宿主轮次上下文优先形成精确归属
    Given 第三方 Agent 宿主为一次用户输入生成了聊天标识和轮次标识
    When 本轮连续调用三个不同工具且每次都携带相同宿主上下文
    Then 三次调用属于同一个轮次
    And 该轮次的归属方式为精确宿主轮次
    And 该轮次的数据质量为可信

  Scenario: 相同问题文本的两个宿主轮次保持分离
    Given 同一聊天窗口连续两轮提出完全相同的问题
    And 宿主为两轮生成了不同轮次标识
    When 两轮分别调用工具
    Then 平台生成两个不同轮次
    And 每次调用只属于对应的宿主轮次

  Scenario: 不同聊天窗口的并发调用保持分离
    Given 同一调用凭据在两个聊天窗口提出相同问题
    And 两个窗口具有不同聊天标识和轮次标识
    When 两个窗口并发调用相同工具
    Then 平台生成两个可信轮次
    And 两个窗口的调用不会互相混入

  Scenario: 未适配宿主按会话和问题推断归属
    Given 第三方 Agent 未提供宿主轮次标识
    And 调用携带有效的传输会话提示和相同用户原始问题
    When 同一会话连续调用多个工具
    Then 多次调用归入同一推断轮次
    And 归属方式为会话与问题推断
    And 数据质量不标记为可信宿主轮次

  Scenario: 没有会话提示时按凭据和问题降级推断
    Given 第三方 Agent 未提供宿主轮次标识和传输会话提示
    And 调用携带用户原始问题
    When 同一凭据在空闲窗口内连续调用多个工具
    Then 调用按凭据和问题指纹进入同一推断轮次
    And 轮次明确记录会话信息缺失

  Scenario Outline: 确定性问题格式错误在下游调用前被拒绝
    Given 调用未提供宿主轮次上下文
    When 兼容问题字段为 <input>
    Then 平台返回可补救的参数错误
    And 下游 MCP 工具未被调用

    Examples:
      | input |
      | 缺失 |
      | 非字符串 |
      | 仅空白 |
      | 超过长度上限 |
      | 包含非法控制字符 |

  Scenario Outline: 启发式问题质量信号不阻断业务调用
    Given 调用携带格式合法的用户问题
    When 问题出现 <signal>
    Then 下游 MCP 工具仍只调用一次
    And 调用事件记录对应质量信号
    And 轮次质量可以被降为存疑

    Examples:
      | signal |
      | 文本过短 |
      | 命中泛化模板 |
      | 与工具参数实体无交集 |

  # M3/M4，tests/collection-reliability.integration.test.ts
  Scenario: 调用前记录成功后才访问下游
    When Agent 发起一次合法工具调用
    Then 平台先持久化唯一的调用开始记录
    And 下游 MCP 工具随后只被调用一次
    And 调用完成后结果和耗时补入同一事件

  Scenario: 调用前持久化失败时拒绝业务调用
    Given 调用事件存储当前不可用
    When Agent 发起一次合法工具调用
    Then 平台返回采集不可用错误
    And 下游 MCP 工具未被调用

  Scenario: 调用完成后的补写失败不重试业务工具
    Given 调用开始记录已经持久化
    And 下游工具已经执行并返回结果
    When 完成结果无法补写
    Then 平台不再次调用下游工具
    And 开始记录保留为部分记录且结果未知
    And 调用方获得原下游结果

  Scenario: 采集端暂时不可用不会丢失已受理事件
    Given L2 采集端暂时不可用
    When 一次调用完成并进入可靠投递队列
    And L2 随后恢复
    Then 待投递事件最终进入 L2
    And 业务工具没有因为投递重试而再次执行

  Scenario: 服务重启后继续投递未完成事件
    Given 数据库中存在尚未成功投递的调用事件
    When LinkCli 进程停止后重新启动
    Then Worker 继续领取并投递该事件
    And 事件不会因进程重启丢失

  Scenario: 重复投递同一调用事件保持幂等
    Given 同一事件因超时被投递两次
    When L2 接收两次相同事件标识
    Then 单次调用明细只有一条
    And 所属轮次的调用数只增加一次

  Scenario: 兼容模式并发首次调用只创建一个轮次
    Given 当前不存在相同凭据、会话和问题的活跃轮次
    When 两个 Worker 并发归集同一轮的首批调用
    Then 平台只创建一个推断轮次
    And 两次调用都属于该轮次

  Scenario: 持续失败的事件进入死信并可重放
    Given 一个调用事件连续投递失败达到上限
    When Worker 完成本轮重试
    Then 事件转为死信且原始事件仍保留
    When 运营者执行死信重放
    Then 事件重新进入待投递状态
    And 非运营者不能执行死信重放

  # M4，tests/turn-grouping.integration.test.ts
  Scenario: 调用顺序不受投递到达顺序影响
    Given 同一轮三个调用按开始顺序为一二三
    And 事件因重试按三一二的顺序到达 L2
    When 轮次完成结算
    Then 轮次详情仍按一二三展示
    And 每条调用保留稳定的开始时间和接收序号

  Scenario: 并行调用保留并行关系
    Given 同一轮两个工具调用的执行时间互相重叠
    When 轮次完成结算
    Then 轮次详情标记两个调用存在并行关系
    And 两个调用具有相同的稳定并行组标识
    And 平台不会虚构二者的严格先后关系

  Scenario: 空闲轮次进入迟到等待后定稿
    Given 一个轮次处于采集中
    When 该轮次空闲达到关闭阈值
    Then 轮次进入迟到等待状态并记录空闲结束原因
    When 迟到等待窗口结束且没有新事件
    Then 轮次进入已定稿状态
    And 生成第一个结算版本

  Scenario: 等待窗口内的新调用让轮次继续采集
    Given 一个轮次处于迟到等待状态
    When 等待截止前收到可确定属于该轮的新事件
    Then 新事件追加到原轮次
    And 轮次重新进入采集中

  Scenario: 定稿后的可确定迟到事件生成修订版本
    Given 一个精确宿主轮次已经定稿
    When 修订窗口内收到相同宿主轮次的迟到事件
    Then 事件追加到原轮次
    And 生命周期保持已定稿
    And 结算版本递增并重新计算调用链

  Scenario: 结算失败保留明细并可重试
    Given 轮次已满足结算条件且调用明细完整
    When 结算计算或写入失败
    Then 轮次的结算状态为失败
    And 原始调用明细保持不变
    When 后续结算重试成功
    Then 结算状态变为已成功
    And 分析层只收到相应结算版本的一次有效事件

  Scenario: 工具执行结果不冒充最终回答质量
    Given 一轮中全部工具调用均成功
    When 轮次完成结算
    Then 执行结论为全部工具成功
    And 结算不声称用户问题已经解决或 Agent 回答正确

  Scenario: 只有满足质量门槛的完整轮次进入分析层
    Given 平台存在可信、推断、存疑和部分记录的已定稿轮次
    When 平台完成这些轮次的结算
    Then 可信和推断且记录完整的轮次生成分析事件
    And 存疑和部分记录的轮次不生成分析事件

  Scenario: 调用错误分类在明细保留期内持续可查
    Given 一次工具调用以稳定错误分类结束
    When L1 已投递记录到期清理但调用明细仍在九十天保留期内
    Then 调用详情仍返回该错误分类
    And 不返回下游错误正文

  # M5，tests/statistics-http.integration.test.ts
  Scenario: 统计聚合可以下钻到轮次和单次调用
    Given 平台已经保存多个项目和工具的轮次记录
    When 有权用户按项目、工具、时间、归属方式和质量查询
    Then 摘要返回轮次数、调用数、错误率和耗时统计
    And 聚合数据可以下钻到对应轮次
    And 轮次可以继续下钻到有序单次调用
    And 聚合计数与下钻明细一致

  Scenario: 项目负责人不能读取其他项目的调用详情
    Given 当前用户只负责项目甲
    And 平台存在项目乙的轮次和调用明细
    When 当前用户查询项目乙的统计或轮次详情
    Then 平台返回无权访问
    And 响应不包含项目乙的问题正文或调用摘要

  Scenario: 九十天后清理正文和调用明细但保留长期统计
    Given 一个轮次的问题正文和调用明细已超过九十天
    When 保留期清理任务运行
    Then 单次调用明细被删除
    And 轮次问题正文被清空并记录清理时间
    And 不含正文的结算摘要和聚合统计仍可查询

  Scenario: 日志和错误响应不包含敏感正文
    Given 调用包含用户问题、敏感参数和下游结果正文
    When 调用成功、失败或发生采集异常
    Then 应用日志不包含用户问题、参数正文、结果正文、平台令牌、项目令牌或指纹密钥
    And 错误响应只包含事件标识和稳定错误语义

  Scenario: 原有标准 MCP 调用与无自动重试约束保持不变
    When Agent 通过标准 Streamable HTTP 获取清单并调用工具
    Then 工具名称、业务参数剥离和业务结果保持原有语义
    And 无论工具成功、业务错误或协议错误，下游调用次数都不超过一次
