import type { AnalysisCall } from "../../src/analysis/types.js";

export interface OperationalProjectFixture {
  id: string;
  key: string;
  name: string;
  modules: Array<{ key:string; tools:Array<{ name:string; operation:string }> }>;
}

export interface LabeledQueryFixture {
  id: string;
  label: string;
  split: "tune" | "blind";
  difficulty: "natural" | "paraphrase" | "hard_negative";
  query: string;
  calls: AnalysisCall[];
}

export const operationalProjects: OperationalProjectFixture[] = [
  {id:"project-commerce",key:"commerce-center",name:"客户订单中心",modules:[
    {key:"customer",tools:[{name:"customer.lookup",operation:"query"}]},
    {key:"order",tools:[{name:"order.query",operation:"query"},{name:"order.update",operation:"update"},{name:"order.cancel",operation:"cancel"},{name:"order.permission",operation:"check"},{name:"order.shipping",operation:"track"}]},
  ]},
  {id:"project-finance",key:"finance-center",name:"财务票据中心",modules:[
    {key:"invoice",tools:[{name:"invoice.query",operation:"query"},{name:"invoice.issue",operation:"create"},{name:"invoice.void",operation:"void"},{name:"invoice.compliance",operation:"check"}]},
    {key:"payment",tools:[{name:"payment.query",operation:"query"},{name:"payment.refund",operation:"refund"}]},
  ]},
  {id:"project-hr",key:"hr-center",name:"人事考勤中心",modules:[
    {key:"employee",tools:[{name:"employee.lookup",operation:"query"}]},
    {key:"attendance",tools:[{name:"attendance.query",operation:"query"},{name:"attendance.correct",operation:"update"},{name:"attendance.anomaly",operation:"analyze"}]},
  ]},
  {id:"project-support",key:"support-center",name:"客户工单中心",modules:[
    {key:"ticket",tools:[{name:"ticket.query",operation:"query"},{name:"ticket.create",operation:"create"},{name:"ticket.close",operation:"close"},{name:"ticket.sla",operation:"analyze"}]},
    {key:"knowledge",tools:[{name:"knowledge.search",operation:"query"}]},
  ]},
  {id:"project-inventory",key:"inventory-center",name:"库存履约中心",modules:[
    {key:"inventory",tools:[{name:"inventory.query",operation:"query"},{name:"inventory.reserve",operation:"reserve"},{name:"inventory.release",operation:"release"}]},
    {key:"supplier",tools:[{name:"supplier.query",operation:"query"}]},
  ]},
  {id:"project-carbon",key:"carbon-accounting",name:"能碳核算中心",modules:[
    {key:"organization",tools:[{name:"organization.lookup",operation:"query"}]},
    {key:"carbon_accounting",tools:[{name:"emission.query",operation:"query"},{name:"emission.report",operation:"report"},{name:"emission.quality",operation:"analyze"}]},
    {key:"factor_library",tools:[{name:"factor.search",operation:"query"}]},
  ]},
];

interface LabelGroup {
  label: string;
  projectId: string;
  modules: string[];
  toolNames: string[];
  operation: string;
  queries: string[];
}

const groups: LabelGroup[] = [
  {label:"customer_order_management",projectId:"project-commerce",modules:["customer","order"],toolNames:["customer.lookup","order.query"],operation:"query",queries:[
    "查一下这个客户最近的订单","我想看看该用户过去买过哪些商品","帮我调出客户的历史购买记录","找到这个人的订单明细","把客户刚提交订单的收货地址改成新地址","取消该客户还没发货的那笔订单",
  ]},
  {label:"order_permission_audit",projectId:"project-commerce",modules:["customer","order"],toolNames:["customer.lookup","order.permission"],operation:"check",queries:[
    "检查这个客户有没有订单审批权限","确认用户能不能审核大额订单","查一下该账号的订单操作授权范围","这个人是否允许批准订单","为什么该客户看得到订单却不能审批","核实用户被授予了哪些订单权限",
  ]},
  {label:"order_delivery_tracking",projectId:"project-commerce",modules:["customer","order"],toolNames:["customer.lookup","order.shipping"],operation:"track",queries:[
    "看看客户订单的物流走到哪里了","查询这名用户包裹的最新轨迹","帮我追踪客户尚未签收的订单","这个人的货什么时候能送到","查客户订单当前由哪个网点配送","用户说没收到货请定位运输状态",
  ]},
  {label:"invoice_lifecycle",projectId:"project-finance",modules:["invoice"],toolNames:["invoice.query"],operation:"query",queries:[
    "查询这张发票现在开到哪一步","给这笔交易申请一张电子发票","把填错抬头的发票作废","下载上个月已经开好的发票","客户的开票申请为什么还没完成","为订单补开增值税专用发票",
  ]},
  {label:"invoice_compliance_review",projectId:"project-finance",modules:["invoice"],toolNames:["invoice.compliance"],operation:"check",queries:[
    "检查发票抬头和税号是否匹配","判断这次开票会不会形成重复发票","核对红字发票是否满足冲销条件","这张票的税率使用得对不对","验证购买方信息是否符合开票规范","排查发票金额与订单金额不一致",
  ]},
  {label:"attendance_record_management",projectId:"project-hr",modules:["employee","attendance"],toolNames:["employee.lookup","attendance.query"],operation:"query",queries:[
    "查一下这名员工本月的打卡记录","看看他昨天几点上下班","帮员工补正漏掉的下班卡","导出这个人的考勤明细","把误记成迟到的记录改回来","查询员工最近一周的出勤情况",
  ]},
  {label:"attendance_anomaly_analysis",projectId:"project-hr",modules:["employee","attendance"],toolNames:["employee.lookup","attendance.anomaly"],operation:"analyze",queries:[
    "分析这名员工为什么连续出现迟到","找出他的考勤异常规律","判断员工缺卡是不是集中在夜班","汇总这个人本月异常出勤原因","核查频繁早退是否和排班冲突有关","识别员工打卡地点异常的日期",
  ]},
  {label:"ticket_lifecycle",projectId:"project-support",modules:["ticket"],toolNames:["ticket.query"],operation:"query",queries:[
    "查询这个客户工单的处理进度","为用户新建一个售后工单","把已经解决的问题单关闭","列出今天分给我的服务请求","给工单补充客户最新反馈","重新打开刚才误关闭的工单",
  ]},
  {label:"ticket_sla_risk",projectId:"project-support",modules:["ticket"],toolNames:["ticket.sla"],operation:"analyze",queries:[
    "哪些客户工单快要超过响应时限","分析这个问题单为什么长期没有处理","找出本周最可能违约的服务请求","检查工单等待时间是否超过SLA","按紧急程度排列积压的客户问题","预测今天哪些工单无法按时结案",
  ]},
  {label:"stock_availability",projectId:"project-inventory",modules:["inventory"],toolNames:["inventory.query"],operation:"query",queries:[
    "查询这个商品现在还有多少可用库存","哪些仓库还有这款产品","看看SKU-2048能不能满足本次订单","汇总各库位的现货数量","这个物料目前是缺货还是有货","查可销售库存并排除已经锁定的数量",
  ]},
  {label:"stock_reservation",projectId:"project-inventory",modules:["inventory"],toolNames:["inventory.reserve"],operation:"reserve",queries:[
    "为这张订单预占十件商品库存","释放取消订单占用的库存","检查本次库存锁定是否成功","把预留数量从十件调整为八件","订单超时后解除对应的库存占用","为促销活动提前冻结一批商品",
  ]},
  {label:"emission_accounting_report",projectId:"project-carbon",modules:["organization","carbon_accounting"],toolNames:["organization.lookup","emission.report"],operation:"report",queries:[
    "生成这家公司的本月碳排放核算报告","汇总组织今年各范围的排放量","查看企业范围一和范围二排放结果","导出该公司的温室气体盘查表","计算这个组织上季度的碳排放总量","按部门生成企业排放明细报告",
  ]},
  {label:"emission_data_quality",projectId:"project-carbon",modules:["organization","carbon_accounting"],toolNames:["organization.lookup","emission.quality"],operation:"analyze",queries:[
    "检查这家企业的排放数据有没有缺项","找出组织碳核算中的异常活动数据","核对排放因子是否与能源类型匹配","分析公司本月排放突然升高的原因","验证各部门上传的能耗凭证是否完整","排查企业碳盘查结果中的重复数据",
  ]},
];

export const labeledQueries: LabeledQueryFixture[] = groups.flatMap((group)=>group.queries.map((query,index)=>({
  id:`${group.label}-${String(index+1).padStart(2,"0")}`,
  label:group.label,
  split:index<4?"tune":"blind",
  difficulty:index<2?"natural":index<4?"paraphrase":"hard_negative",
  query,
  calls:group.modules.map((moduleId,callIndex)=>({
    sequence:callIndex+1,projectId:group.projectId,moduleId,toolName:group.toolNames[callIndex]!,
    operation:callIndex===group.modules.length-1?group.operation:"query",parameterKeys:["id"],outcome:"success" as const,
  })),
})));

export const labeledQueryDatasetVersion = "l3-operational-v1";
