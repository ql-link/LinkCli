@MCPSTAT-1-L1
Feature: 企业内部标准 MCP 服务登记、审核与统一调用
  为了让企业内多个标准 MCP 项目通过一个入口安全、稳定地被 Agent 使用
  作为平台运营者、项目负责人和外部 Agent
  我希望平台只发布经过审核且可用的工具，并在调用时保持项目自身的业务权限边界

  Background:
    Given 平台只接受标准 MCP 服务登记
    And 可信项目免审功能默认关闭
    And 第一阶段不配置项目级或工具级平台授权

  # M1：服务登记与审核
  @M1 @main
  Scenario: 首次登记成功后默认进入待审核状态
    Given 项目负责人提交了可连接的标准 MCP 地址和有效项目 Token
    And 下游服务返回了名称唯一且定义完整的工具清单
    When 平台完成服务发现并提交登记
    Then 平台应保存不可变的候选版本和工具快照
    And 候选版本应进入待审核状态
    And 项目及其工具不应进入统一工具清单

  @M1 @validation
  Scenario Outline: 无法完成标准 MCP 发现时登记失败
    Given 项目负责人正在登记一个新项目
    And 下游服务存在“<异常>”
    When 平台尝试连接并发现工具
    Then 登记应失败并返回可定位的“<错误>”
    And 不应发布服务版本或工具

    Examples:
      | 异常 | 错误 |
      | 地址不可达 | 连接失败 |
      | 项目 Token 无效 | 下游认证失败 |
      | 服务不支持标准 MCP | 协议不支持 |

  @M1 @validation
  Scenario: 同一项目返回重名工具时拒绝登记
    Given 下游标准 MCP 服务返回两个相同名称的工具
    When 平台尝试创建候选版本
    Then 登记应失败并指出工具名称冲突
    And 不应产生可提交审核的版本

  @M1 @permission
  Scenario: 未开启免审时可信项目仍需人工审核
    Given 项目被标记为可信项目
    And 可信项目免审功能仍为关闭状态
    When 项目负责人提交首次登记
    Then 候选版本应进入待审核状态
    And 不应在没有审核结论时发布

  @M1 @permission @main
  Scenario: 开启免审的可信项目仍需首次探活成功后发布
    Given 项目被标记为可信项目
    And 可信项目免审功能已由有权人员开启
    When 项目负责人提交定义完整的首次登记
    Then 平台应记录免审结论
    And 项目应保持待发布直至首次探活成功
    When 首次探活成功
    Then 版本应原子发布并进入统一工具清单

  @M1 @state
  Scenario: 审核批准但首次探活失败时保持不可用
    Given 一个候选版本处于待审核状态
    When 审核人批准该版本
    And 该版本首次探活失败
    Then 审核结论应保持已批准
    And 项目应保持待发布且健康状态不应为健康
    And 工具不应进入统一工具清单
    And 项目负责人应能看到探活失败告警

  @M1 @main
  Scenario: 审核批准且首次探活成功后原子发布
    Given 一个候选版本处于待审核状态
    When 审核人批准该版本
    And 该版本首次探活成功
    Then 项目应进入正常服务状态
    And 该版本应成为唯一生效版本
    And 该版本的全部工具应同时进入统一工具清单

  @M1 @exception
  Scenario: 审核驳回时保留原因和原生效版本
    Given 项目已有一个正在服务的生效版本
    And 新候选版本处于待审核状态
    When 审核人填写原因并驳回新候选版本
    Then 新候选版本应进入已驳回终态并保留审核记录
    And 原生效版本应继续服务
    And 统一工具清单不应切换到被驳回版本

  @M1 @concurrency @idempotency
  Scenario: 并发审核以第一个有效结论为准
    Given 一个候选版本处于待审核状态
    When 两名审核人并发提交相反的审核结论
    Then 仅第一个成功提交的结论应生效
    And 后续提交应得到包含当前实际状态的冲突响应
    And 不应产生两个生效审核结论

  @M1 @idempotency
  Scenario: 重复提交候选版本不产生重复版本
    Given 项目负责人已成功提交一个内容相同的候选版本
    When 项目负责人用同一请求再次提交
    Then 平台应返回第一次提交对应的版本结果
    And 不应新增重复候选版本或重复审核任务

  @M1 @state
  Scenario: 审核终态版本不可被修改或退回草稿
    Given 一个版本已经处于已批准或已驳回状态
    When 项目负责人尝试修改该版本定义或退回草稿
    Then 平台应拒绝该状态流转
    And 原版本内容和审核记录应保持不变
    And 后续调整只能创建新候选版本

  @M1 @regression
  Scenario: 低风险变更审核期间旧版本继续服务
    Given 项目已有一个健康的生效版本
    And 平台发现不影响输入输出权限语义或副作用的定义变化
    When 平台创建待审核候选版本
    Then 原生效版本及其工具应继续接收新调用
    And 候选版本不应在批准前进入统一工具清单

  @M1 @risk @state
  Scenario: 高风险或不兼容变更立即暂停对应工具和关联 Skill
    Given 项目已有一个健康的生效版本
    And 平台发现工具的输入输出权限语义或副作用发生高风险变化
    When 平台创建待审核候选版本
    Then 受影响工具应立即进入暂停状态并移出统一工具清单
    And 平台应通知关联 Skill 暂停使用该工具
    And 同项目未受影响的工具应继续服务

  @M1 @risk @state
  Scenario: 高风险候选版本发布后原子恢复工具和关联 Skill
    Given 某工具因高风险变更处于暂停状态
    And 对应候选版本已审核通过
    When 新版本探活成功并发布
    Then 新版本应原子替换旧生效版本
    And 工具应恢复正常并重新进入统一工具清单
    And 平台应通知关联 Skill 风险已经解除

  @M1 @state @idempotency
  Scenario: 停用项目立即移出清单但允许在途调用完成
    Given 一个项目处于正常服务状态
    And 该项目存在已经开始但尚未完成的调用
    When 项目负责人或运营者停用该项目
    Then 项目及其工具应立即移出统一工具清单
    And 新调用应被拒绝为服务不可用
    And 已经开始的调用应继续绑定原版本完成
    When 再次提交停用操作
    Then 平台应保持已停用状态且不产生重复副作用

  @M1 @state
  Scenario: 已停用项目只有探活成功后才能重新启用
    Given 一个项目处于已停用状态
    When 有权人员请求重新启用项目
    And 项目探活仍未成功
    Then 项目应保持已停用并继续不出现在统一工具清单
    When 项目探活成功
    Then 项目应恢复正常服务并重新进入统一工具清单

  @M1 @state @boundary
  Scenario: 项目必须先停用才能永久下线
    Given 一个项目处于正常服务状态
    When 运营者直接请求永久下线
    Then 平台应拒绝非法状态流转
    When 运营者先停用再确认永久下线
    Then 项目应进入不可恢复的已下线状态
    And 项目标识不应允许被其他项目复用

  @M1 @health
  Scenario: 连续失败达到阈值后标记不健康并熔断
    Given 一个项目处于正常服务且健康状态
    When 连续探活失败达到运行阈值
    Then 项目健康状态应变为不健康
    And 项目工具应从统一工具清单移除
    And 新调用应在访问下游前返回服务暂不可用

  @M1 @health
  Scenario: 连续成功达到恢复阈值后恢复服务
    Given 一个项目因连续失败处于不健康状态
    When 连续探活成功达到恢复阈值
    Then 项目健康状态应恢复为健康
    And 未被人工停用或风险暂停的工具应重新进入统一工具清单

  @M1 @health @boundary
  Scenario: 长时间未刷新健康结论时按未知处理
    Given 一个项目最近一次健康结论已经超过有效时限
    When 外部 Agent 刷新统一工具清单或发起调用
    Then 平台应将当前健康结论按未知处理
    And 不应把该项目工具作为健康可用工具提供

  @M1 @timeout
  Scenario: 待审核超过七天只告警不自动决定
    Given 一个候选版本已经待审核超过七天
    When 审核滞留检查执行
    Then 平台应向相关人员产生告警
    And 候选版本仍应保持待审核
    And 平台不应自动批准或驳回该版本

  # M2：统一网关
  @M2 @permission @main
  Scenario: 任一有效平台凭据可读取全部可用工具
    Given 平台存在多个已发布且健康的项目
    And 这些项目的工具均未被暂停
    And 两个外部 Agent 分别使用不同的有效平台凭据
    When 两个 Agent 分别请求统一工具清单
    Then 两个 Agent 应获得相同的全部可用工具集合
    And 平台不应按项目或工具对有效凭据做差异授权

  @M2 @authentication
  Scenario Outline: 无效平台凭据在转发前被拒绝
    Given 外部 Agent 使用“<凭据状态>”的平台凭据
    When Agent 请求工具清单或调用工具
    Then 平台应返回认证错误
    And 不应连接或调用任何下游项目 MCP

    Examples:
      | 凭据状态 |
      | 缺失 |
      | 过期 |
      | 已吊销 |

  @M2 @catalog
  Scenario: 统一工具清单只包含已发布健康且未暂停的工具
    Given 平台同时存在待审核 已驳回 已停用 已下线 不健康和工具暂停的记录
    And 平台也存在已发布健康且未暂停的工具
    When 使用有效平台凭据的 Agent 请求统一工具清单
    Then 清单只应包含已发布健康且未暂停的工具
    And 其他状态的项目版本或工具不应出现在清单中

  @M2 @catalog @validation
  Scenario: 跨项目同名工具使用稳定项目前缀区分
    Given 两个健康项目都发布了名为 search 的工具
    When Agent 请求统一工具清单
    Then 清单中应出现两个带各自稳定项目前缀的工具名
    And 两个工具名应唯一且分别路由到正确项目

  @M2 @validation
  Scenario: 统一工具定义要求提供用户原始问题
    Given Agent 已获得某个统一工具的定义
    Then 该工具定义应包含必填的用户原始问题参数
    When Agent 未提供用户原始问题而发起调用
    Then 平台应返回可修正的参数校验错误
    And 不应调用下游项目 MCP

  @M2 @main @security
  Scenario: 网关使用项目 Token 调用下游并保持业务参数不变
    Given Agent 使用有效平台凭据调用一个可用工具
    And 调用包含用户原始问题和合法业务参数
    When 网关把请求转发给对应项目 MCP
    Then 网关应使用该项目配置的项目 Token 完成下游认证
    And 下游业务参数不应包含平台凭据 用户原始问题 终端用户身份或内部路由字段
    And Agent 应获得与直接调用该项目工具一致的业务结果

  @M2 @permission
  Scenario: 项目 MCP 自行决定项目内部业务权限
    Given 平台配置的项目 Token 无权访问某项项目内部业务数据
    And Agent 使用有效平台凭据调用对应工具
    When 网关携带项目 Token 调用项目 MCP
    Then 项目 MCP 应自行作出权限拒绝
    And 网关应向 Agent 返回可识别的下游权限错误
    And 平台不应绕过或替代项目的业务权限判断

  @M2 @security
  Scenario: 调用响应和日志不得泄露任何凭据
    Given Agent 使用有效平台凭据完成一次工具调用
    When 平台返回响应并记录审计和运行日志
    Then 响应和日志不应包含原始平台凭据或项目 Token
    And 日志不应包含完整用户问题 完整工具参数或完整结果
    And 项目 Token 不应返回给外部 Agent

  @M2 @attribution
  Scenario: 网关为调用生成稳定且可区分的轮次标识
    Given 同一认证主体在同一连接会话中连续发起两次调用
    When 网关处理这些调用
    Then 每次调用在处理和投递期间应使用同一个非空轮次标识
    And 两次调用应因调用次序不同获得不同的轮次标识
    And 调用方不需要提交自定义对话编号
    And 投递给 L2 的记录应包含脱敏后的用户原始问题和网关生成的轮次标识

  @M2 @resilience
  Scenario: L2 投递失败不改变已经产生的业务结果
    Given 下游项目 MCP 已成功返回工具结果
    And L2 采集入口当前不可用
    When 网关异步投递调用过程
    Then Agent 仍应收到成功的业务结果
    And 平台应记录投递失败指标并按有界策略暂存或丢弃
    And L2 故障不应反向阻塞工具调用

  @M2 @exception
  Scenario Outline: 不可调用的工具在访问下游前返回明确错误
    Given Agent 使用有效平台凭据调用“<工具状态>”的工具
    When 网关解析并校验目标工具
    Then 网关应返回“<错误>”
    And 不应向下游项目 MCP 发起工具调用

    Examples:
      | 工具状态 | 错误 |
      | 不存在 | 工具不存在 |
      | 所属项目已下线 | 工具不存在 |
      | 所属项目不健康 | 服务暂不可用 |
      | 工具已暂停 | 服务暂不可用 |
      | 旧缓存中的失效版本 | 工具版本已失效 |

  @M2 @timeout @no-retry
  Scenario: 下游调用超时后不自动重试
    Given 一个可用工具的下游调用超过硬超时时限
    When 网关终止本次等待
    Then Agent 应收到明确的超时错误
    And 本次调用只应向下游发送一次
    And 失败结果应计入健康判断

  @M2 @no-retry @boundary
  Scenario: 第一阶段任何工具调用失败都不自动重试
    Given 一个工具调用已经被下游接收并返回失败
    When 网关处理该失败结果
    Then 网关不应基于工具读写类型再次发送调用
    And Agent 应收到本次调用对应的标准化错误

  @M2 @regression
  Scenario: 版本切换时在途调用绑定旧版本而新调用使用新版本
    Given 一个工具旧版本存在尚未完成的在途调用
    And 新候选版本已经审核通过并探活成功
    When 平台原子切换生效版本
    Then 在途调用应继续绑定旧版本完成
    And 切换后的新调用应只路由到新生效版本
    And 任一时刻都不应把一次调用同时发送给两个版本
