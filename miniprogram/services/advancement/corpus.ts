/**
 * 升学 / 实习问答语料（数据，不含逻辑）。
 *
 * **本文件由 `docs/evidence/advancement-poc/corpus.json` 生成，不要手改**：
 * 语料的唯一来源是那份 PoC 语料文件（4 份官方材料、逐字段落、每段带出处与核查日）。
 * 重新生成：`node scripts/generate-advancement-corpus.cjs`（见该脚本头部的说明）。
 *
 * 纪律：`text` 一律是官方原文的逐字摘录，回答与引用只能用它；`context` 只为检索打分添加，
 * 不得出现在界面上当作原文。
 */
export interface AdvancementPassage {
  id: string;
  text: string;
  /** 只用于检索打分的关键词标签，不是原文。 */
  context: string;
}

export interface AdvancementDocument {
  id: string;
  category: 'ordinary_专升本' | 'segmented_三二分段专升本转段' | 'internship_实习招聘';
  title: string;
  documentNumber: string;
  issuer: string;
  publishedAt: string;
  applicableYear: number;
  applicableRegion: string;
  applicableAudience: string;
  sourceUrl: string;
  collectedAt: string;
  passages: AdvancementPassage[];
}

export const CORPUS_COLLECTED_AT = "2026-09-29";

export const ADVANCEMENT_DOCUMENTS: AdvancementDocument[] = [
  {
    "id": "gd-zsb-2026",
    "category": "ordinary_专升本",
    "title": "广东省2026年普通高等学校专升本招生工作规定",
    "documentNumber": "粤招办普〔2025〕51号",
    "issuer": "广东省教育考试院",
    "publishedAt": "2025-11-19",
    "applicableYear": 2026,
    "applicableRegion": "广东省",
    "applicableAudience": "符合报考条件的专科毕业生（含应届与往届）",
    "sourceUrl": "https://eea.gd.gov.cn/bmbk_sksywj/content/post_4802375.html",
    "collectedAt": "2026-09-29",
    "passages": [
      {
        "id": "gd-zsb-2026#register-time",
        "text": "网上预报名时间为2026年1月12日09:00至19日18:00",
        "context": "普通专升本 报名时间 网上预报名 报名开始 报名截止"
      },
      {
        "id": "gd-zsb-2026#fee-deadline",
        "text": "网上缴费截止时间为1月23日17:00",
        "context": "普通专升本 缴费时间 网上缴费截止 报考费"
      },
      {
        "id": "gd-zsb-2026#exam-time",
        "text": "2026年3月28日（星期六）至29日（星期日）两天",
        "context": "普通专升本 考试时间 统考时间 笔试时间 考试日期"
      },
      {
        "id": "gd-zsb-2026#volunteer",
        "text": "2026年普通专升本实行考后知分填报志愿；提前批（职教师资类专业）设置1个院校专业组志愿，普通批设置10个院校专业组志愿，建档立卡批次设置5个院校专业组志愿",
        "context": "普通专升本 志愿填报 院校专业组 提前批 普通批 建档立卡 考后知分"
      },
      {
        "id": "gd-zsb-2026#admission",
        "text": "按考生类别……专业基础课分别划定三科总分……和专业综合课两条最低控制分数线；依照“分数优先，遵循志愿”的原则",
        "context": "普通专升本 录取 投档 最低控制分数线 分数优先遵循志愿"
      },
      {
        "id": "gd-zsb-2026#vocational-teacher",
        "text": "报考职教师资专业的，需符合上述条件之一，且必须在志愿填报开始前取得与报考专业相对应的中级及以上职业资格技能等级证书等。",
        "context": "职教师资 报考条件 职业资格技能等级证书 中级及以上"
      },
      {
        "id": "gd-zsb-2026#bonus",
        "text": "增加15分投档；增加10分投档；增加5分投档",
        "context": "加分照顾政策 加分分值 投档加分 15分 10分 5分"
      },
      {
        "id": "gd-zsb-2026#physical-exam",
        "text": "考生须依据《广东省2026年普通高校专升本招生体格检查表》（附件6）的规定，自行前往二级甲等（含）以上医院或相应的医疗单位进行体检，填报志愿开始前将体检结果上传至报名系统中（体检表有效期：2026年1月1日至填报志愿第一天）。",
        "context": "体检要求 体格检查表 二级甲等 有效期 上传体检结果"
      },
      {
        "id": "gd-zsb-2026#vet-soldier",
        "text": "退役大学生士兵可申请参加相关高校的退役大学生士兵免文化课考试专升本招生，具体办法见《关于做好广东省2026年普通高等学校专升本免文化课考试招收退役大学生士兵工作的通知》（粤招办普〔2025〕50号）。",
        "context": "退役大学生士兵 免文化课考试 免试专升本 50号文"
      },
      {
        "id": "gd-zsb-2026#not-eligible",
        "text": "具有普通高等学历教育资格的高校非应届毕业在校生（含保留学籍的学生）；因违反国家教育考试规定，被给予暂停参加普通专升本招生考试处理且在停考期内的人员；因触犯刑律受到刑事处罚、尚在处罚期内的；不符合报考条件的其他人员",
        "context": "不得报考 报考限制 停考期 非应届在校生 刑事处罚"
      }
    ]
  },
  {
    "id": "gd-segmented-2026",
    "category": "segmented_三二分段专升本转段",
    "title": "关于做好广东省2026年普通高等学校三二分段专升本转段招生工作的通知",
    "documentNumber": "粤招办普〔2025〕53号",
    "issuer": "广东省招生委员会办公室",
    "publishedAt": "2025-11-29",
    "applicableYear": 2026,
    "applicableRegion": "广东省",
    "applicableAudience": "2023 年试点高职院校招收的三二分段专升本应用型人才培养全日制学生",
    "sourceUrl": "https://eea.gd.gov.cn/ptgk/content/post_4806517.html",
    "collectedAt": "2026-09-29",
    "passages": [
      {
        "id": "gd-segmented-2026#target",
        "text": "1.2023年试点高职院校招收、符合有关文件要求的三二分段专升本应用型人才培养的全日制学生。",
        "context": "三二分段 专升本 转段 招生对象 试点高职 应用型人才培养 全日制学生"
      },
      {
        "id": "gd-segmented-2026#quality-check",
        "text": "2.在试点高职院校学习期间，遵守国家法律法规和校纪校规，基本素质考核为“合格”者。基本素质考核“不合格”的学生，不得报考。",
        "context": "转段 基本素质考核 合格 不合格不得报考"
      },
      {
        "id": "gd-segmented-2026#register",
        "text": "2026年转段招生考试实行网上预报名、网上审核和网上缴费。网上预报名时间为2026年1月12日09:00至19日18:00；考生提交预报名资料的48小时内，对口试点本科高校完成资料审核，考生可登录系统查看报名资格审核结果，审核结果为“通过”的考生可以缴费；网上缴费截止时间为1月23日17:00。",
        "context": "转段 报名时间 网上预报名 审核 缴费截止"
      },
      {
        "id": "gd-segmented-2026#fee",
        "text": "报考费：按照普通高等学校普通专升本报名考试收费标准执行，每科40元",
        "context": "转段 报考费 每科40元"
      },
      {
        "id": "gd-segmented-2026#parts",
        "text": "转段招生考核包括公共课程统一考试科目考核、基本素质考核、专业能力考核共三个部分，实行“分项考核、综合评价”。",
        "context": "转段考核构成 公共课程统一考试 基本素质考核 专业能力考核 三个部分"
      },
      {
        "id": "gd-segmented-2026#exam-time",
        "text": "普通高等学校转段招生统一考试科目考核时间为2026年3月28日（星期六）至29日（星期天）",
        "context": "转段 统一考试时间 考试日期"
      },
      {
        "id": "gd-segmented-2026#exemption",
        "text": "学生在高职学段参加教育部或省教育厅主办的世界、全国或全省职业院校技能大赛，获得国家级三等奖及以上或省级一等奖的，可免予专业能力……考核，并将专业能力考核等级定为优秀。",
        "context": "免考 免予专业能力考核 技能大赛 国家级三等奖 省级一等奖"
      },
      {
        "id": "gd-segmented-2026#vet-soldier",
        "text": "从广东省应征入伍的退役大学生士兵考生，免于文化课考试……；在服义务兵役期间荣立三等功及以上奖励的退役大学生士兵，免于参加文化课考试、专业能力考核，并将专业能力考核等级定为合格。",
        "context": "退役大学生士兵 免文化课考试 三等功 免专业能力考核"
      },
      {
        "id": "gd-segmented-2026#graduation",
        "text": "转入本科专业三年级学习，毕业证书标注“专科起点本科学习”；毕业后就业办法与普通高校本科毕业生相同",
        "context": "转段 毕业证书 专科起点本科 就业 本科毕业生"
      }
    ]
  },
  {
    "id": "gd-employment-2026",
    "category": "internship_实习招聘",
    "title": "2026年广东省高校毕业生就业创业十大行动方案",
    "documentNumber": "粤就劳发〔2026〕1号",
    "issuer": "广东省就业促进和劳动保护工作领导小组",
    "publishedAt": "2026-03-28",
    "applicableYear": 2026,
    "applicableRegion": "广东省",
    "applicableAudience": "2026 届高校毕业生",
    "sourceUrl": "https://hrss.gd.gov.cn/zwgk/xxgkml/bmwj/qtwj/jycy/content/mpost_4880166.html",
    "collectedAt": "2026-09-29",
    "passages": [
      {
        "id": "gd-employment-2026#civil-servant",
        "text": "全省提供公务员岗位不少于1.5万个",
        "context": "就业行动 公务员岗位 数量 1.5万个"
      },
      {
        "id": "gd-employment-2026#public-institution",
        "text": "全年全省提供事业单位岗位不少于5万个",
        "context": "就业行动 事业单位岗位 数量 5万个"
      },
      {
        "id": "gd-employment-2026#soe",
        "text": "力争招用高校毕业生不少于1.7万人",
        "context": "就业行动 国有企业 招用高校毕业生 1.7万人"
      },
      {
        "id": "gd-employment-2026#research-assistant",
        "text": "全省开发1万个以上科研助理岗位",
        "context": "就业行动 科研助理岗位 1万个以上"
      },
      {
        "id": "gd-employment-2026#upgrade-plan",
        "text": "普通专升本计划招生6.5万人",
        "context": "就业行动 普通专升本 计划招生 6.5万人"
      }
    ]
  },
  {
    "id": "gd-employment-portal",
    "category": "internship_实习招聘",
    "title": "广东学生就业创业（广东省教育厅专题页）",
    "documentNumber": "",
    "issuer": "广东省教育厅",
    "publishedAt": "",
    "applicableYear": 0,
    "applicableRegion": "广东省",
    "applicableAudience": "广东省高校毕业生与用人单位",
    "sourceUrl": "http://edu.gd.gov.cn/ztzlnew/jycy/",
    "collectedAt": "2026-09-29",
    "passages": [
      {
        "id": "gd-employment-portal#entry",
        "text": "广东学生就业创业网；用人单位登录入口；国聘行动；“就在南粤”广东省普通高校毕业生供需对接活动；高校毕业生就业创业“政策地图”",
        "context": "就业服务入口 广东学生就业创业网 招聘活动 供需对接 国聘行动 政策地图"
      }
    ]
  }
];
