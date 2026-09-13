/**
 * 冲突裁决落盘：跨来源 6 组（v2 口径）+ 单来源 53 组
 * 产出:
 *   merged2/conflicts_resolved_manual.json        —— 6 组跨来源（含根因判定）
 *   merged2/conflicts_single_source_resolved.json —— 53 组单来源（含答案/依据/置信度）
 *   merged2/answer_overrides.json                 —— 需改判的 dupKey → 正确答案
 * 用法: node resolve_conflicts.mjs
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const M2 = path.join(ROOT, 'merged2');
const rd = f => JSON.parse(fs.readFileSync(path.join(M2, f), 'utf8'));
const wr = (f, o) => fs.writeFileSync(path.join(M2, f), JSON.stringify(o, null, 1));

// ============ 一、跨来源 6 组（原始名单，v2 已证实 5 组是伪冲突） ============
const CROSS = [
  {
    no: 1, subject: '神经病学', stem: '运动系统最主要和最基本的检查方法是',
    claim: '极光 D. / 医考帮 D', verdict: 'D', verdictType: '一致（仅标点差异）', confidence: 'high',
    basis: '《神经病学》（人卫第9版）第四章：运动系统的检查以视诊、触诊、叩诊、动诊、量诊等「物理学检查（查体）」为主，是最主要、最基本的检查方法；X线/CT/MRI/肌电图属辅助手段。极光侧写作「D.」、医考帮侧「D」，仅尾点差异。',
    v2Stem: '运动系统最主要和最基本的检查方法是',
    action: '规范化答案（去掉尾点）后判为一致，无需改判。'
  },
  {
    no: 2, subject: '外基', stem: '该患者最可能的诊断是',
    claim: '未知来源 B；考研2012 D×2 / A / B',
    verdict: '不裁决（非同一题）', verdictType: '伪冲突 · 合并键缺陷', confidence: 'high',
    basis: '回原始分片核验：这 5 条只是**小问题干恰好相同**的 5 道不同 A2 病例题 —— ①外科基础·慢性疼痛分类（选项=5类慢性疼痛）；②内科学·泌尿·原发性醛固酮增多症；③外科学·综合病例·扩张型心肌病；④外科学·胃肠外科·血栓性外痔；⑤外科学·创伤与烧伤·脾破裂。后四条选项集合完全不同（高血压类／心肌病类／肛肠类／腹腔脏器类）。v1 只用题干入键导致误合并。',
    v2Stem: null, action: '已由 merge v2（题干+选项指纹）自动拆为 5 条独立题，各自保留原答案。附带发现：①外科基础那条**病例文本本身缺失**（其自带解析亦写明「本题未提供具体病例信息」），已标 stemIncomplete。'
  },
  {
    no: 3, subject: '外科学', stem: '肝癌破裂出血的治疗方法有',
    claim: '医考帮 ACD / 考研2021 ABC / 考研2022 ABD',
    verdict: '三条各自均正确', verdictType: '伪冲突 · 同年份不同选项版本', confidence: 'high',
    basis: '回原始分片核验：三条**选项集合不同**，是同一考点的三个版本 —— 医考帮版{A手术切除/B肝动脉化疗/C肝动脉栓塞/D纱布填压}→ACD（化疗非急症止血手段）；2021版{A手术切除/B肝动脉栓塞/C非手术治疗/D放射治疗}→ABC（裂口小可自行止血=非手术，放疗不用于破裂出血）；2022版{A手术切除/B肝动脉栓塞/C肝动脉化疗/D砂布填压}→ABD（其解析明确「急诊做肝动脉栓塞或者肝动脉化疗栓塞」）。教材依据：《外科学》（人卫第9版）第三十八章肝疾病——肝癌结节破裂出血处理含急诊手术切除、肝动脉结扎/栓塞、纱布填塞止血，及小裂口保守观察。',
    v2Stem: null, action: 'v2 已按选项指纹拆为 3 条独立题，各保留本版答案，均不改判。'
  },
  {
    no: 4, subject: '生物化学', stem: '下列关于TATA盒的叙述，正确的是',
    claim: '医考帮 E / A；考研2006 A / 考研2005 E',
    verdict: '两条各自均正确', verdictType: '伪冲突 · 2005/2006 两版不同选项', confidence: 'high',
    basis: '回原始分片核验：是**两个年份的真题**，选项集合完全不同 —— 2005版{A位于操纵子的第一个结构基因处/B负性顺式调节元件/C能编码阻遏蛋白/D发挥作用方式与方向无关/E能与RNA聚合酶结合}→**E**（TATA盒=Hogness盒，位于转录起始点上游-25~-30bp，是启动子核心序列，经TFⅡD与RNA聚合酶结合；A/C属原核操纵子范畴，B是沉默子的性质，D错因TATA盒有方向性）；2006版{A是与RNA-pol稳定结合的序列/B是蛋白质翻译的起始点/C是DNA复制的起始点/D是与核蛋白体稳定结合的序列/E是远离转录起始点、增强转录活性的序列}→**A**（E描述的是增强子）。依据：《生物化学与分子生物学》（人卫第10版）P280/P318/P329。',
    v2Stem: null, action: 'v2 已拆为 2 条独立题，各保留本版答案，均不改判。'
  },
  {
    no: 5, subject: '生物化学', stem: '能够调节血红蛋白运氧功能的物质是',
    claim: '考研2025 A / 医考帮 A / 医考帮 B / 考研2017 B',
    verdict: '两条各自均正确', verdictType: '伪冲突 · 2025/2017 两版不同选项', confidence: 'high',
    basis: '回原始分片核验：是**两个年份的真题** —— 2025版{A 2,3-BPG / B ALA / C MHb / D NADPH}→**A**（2,3-BPG与脱氧Hb的β链成盐键，稳定T构象、降低O₂亲和力；ALA是血红素合成中间产物，MHb是氧化型高铁血红蛋白已失去携氧力，NADPH维持GSH还原态）；2017版{A三羧酸循环产物/B 2,3-二磷酸甘油酸旁路产物/C磷酸戊糖途径产物/D丙酮酸脱氢酶复合体催化产物}→**B**（即2,3-BPG旁路，同一知识点的另一问法）。依据：《生理学》（人卫第10版）P151、《生物化学与分子生物学》第二十六章血液生化。',
    v2Stem: null, action: 'v2 已拆为 2 条独立题，各保留本版答案，均不改判。'
  },
  {
    no: 6, subject: '病理学', stem: '下列肿瘤中，属于良性肿瘤的是',
    claim: '医考帮 C / D；考研2006 B / 考研2016 D',
    verdict: 'C', verdictType: '真冲突 · 2016版录入错误（唯一一组）', confidence: 'high',
    basis: '回原始分片核验：共 3 个选项版本 —— 2006版{A视网膜母细胞瘤/B神经母细胞瘤/C骨母细胞瘤/D肾母细胞瘤/E肝母细胞瘤}：医考帮标 C、考研真题标 B，**二者选项集合完全相同，故为真冲突**。教材依据：《病理学》（人卫第9版）第六章肿瘤——母细胞瘤多属恶性（视网膜母细胞瘤、神经母细胞瘤、髓母细胞瘤、肾母细胞瘤、肝母细胞瘤），良性者为**骨母细胞瘤、软骨母细胞瘤、肌母细胞瘤、脂肪母细胞瘤**。该考研条目**自带解析亦写明良性者是骨母细胞瘤/软骨母细胞瘤**，故其标注的 B（神经母细胞瘤=恶性）为录入错误，正确答案 **C**。另 2016版{A母细胞瘤/B髓母细胞瘤/C神经母细胞瘤/D软骨母细胞瘤}→**D**（软骨母细胞瘤，良性），医考帮与考研一致，无冲突。',
    v2Stem: '下列肿瘤中，属于良性肿瘤的是',
    action: 'v2 仍保留该冲突；已改判为 C（考研真题 2006 该条答案录入错误）。'
  }
];

// ============ 二、单来源 53 组裁决表 ============
// key = 学科 + '|' + 题干唯一片段；v = 裁决答案；amb = 不可文本裁决
const SINGLE = [
  { m: '军事理论|标志着中国军事思想发展到一个全新的阶段', v: 'B', c: 'high', b: '毛泽东军事思想的形成，标志中国军事思想发展到一个全新阶段；其人民战争理论对第三世界民族解放运动影响深远。另三选项为后世军事思想。' },
  { m: '军事理论|是毛泽东军事思想的核心内容', v: 'A', c: 'high', b: '人民战争思想是毛泽东军事思想的核心（积极防御是战略方针，运动战/游击战是作战形式）。' },
  { m: '军事理论|在信息化战争中', v: 'D', c: 'high', b: '信息化战争以信息为主导，信息优势是衡量力量优劣的首要标志（火力/兵力/机动优势均从属）。' },
  { m: '系统解剖学|下列动脉中，与伴行静脉不同名的是', v: 'D', c: 'high', b: '颈总动脉无同名静脉伴行（伴行为头臂静脉）；面动脉-面静脉、腋动脉-腋静脉、股动脉-股静脉、颈内动脉-颈内静脉均同名。' },
  { m: '系统解剖学|下列关于侧支循环的描述', v: 'C', c: 'high', b: '侧副支可有多条。A错（侧副支比主干细）；B错（主干通畅时侧副循环不开放）；D错（管径随功能负荷变化）；E错（主干阻塞时侧副支代偿性增粗）。' },
  { m: '系统解剖学|走行于后室间沟的静脉属支是', v: 'D', c: 'high', b: '后室间沟内走行心中静脉，与后室间支（右冠状动脉）伴行。心大静脉在前室间沟，心小静脉在冠状沟右侧。' },
  { m: '系统解剖学|比较左右心室', v: 'ABCD', c: 'high', b: 'A对（左室→升主动脉、右室→肺动脉干）；B对（左室壁约为右室壁3倍）；C对（均分流入道/流出道）；D对（均有肉柱、乳头肌）；E错（左室2组乳头肌，右室3组）。' },
  { m: '组织学与胚胎学|箭头所示的结构为', amb: 'imageMissing' },
  { m: '组织学与胚胎学|图中标箭头的细胞是何种细胞', amb: 'imageMissing' },
  { m: '组织学与胚胎学|图中标箭头的是何种细胞', amb: 'imageMissing' },
  { m: '医学细胞生物学|溶酶体膜的特殊性在于', v: 'C', c: 'mid', b: '溶酶体膜蛋白多为糖蛋白、糖链朝向膜内侧（膜内侧糖类丰富），可保护膜免遭自身水解酶消化，此为溶酶体膜的特征性结构；B"由磷脂及蛋白质组成"是所有生物膜共性，非特殊性。' },
  { m: '医学细胞生物学|溶酶体酶发挥活性的最适pH', v: 'C', c: 'high', b: '溶酶体内部呈酸性，pH约4.5~5.5，溶酶体酶（如酸性磷酸酶）最适pH约5。选项C（5-6）为最接近项。' },
  { m: '医学细胞生物学|下列哪种特点是溶酶体膜不具备的', v: 'E', c: 'high', b: '溶酶体膜上有H⁺泵（V-型ATP酶）维持腔内酸性，无Na⁺通道；膜蛋白高度糖基化亦成立。' },
  { m: '医学细胞生物学|对线粒体内膜通透性描述正确的是', v: 'D', c: 'high', b: '线粒体内膜富含心磷脂，通透性低、对离子高度不通透，构成氧化磷酸化的屏障；孔蛋白位于外膜（允许<5000 Da通过），内膜不含孔蛋白，胆固醇含量低。' },
  { m: '医学细胞生物学|关于半桥粒的说法错误的', v: 'D', c: 'high', b: '半桥粒胞内连接的骨架成分是**中间丝（角蛋白）**而非肌动蛋白束；A、B、C均正确。故D错误。' },
  { m: '医学细胞生物学|细胞周期的概念是', v: 'B', c: 'high', b: '细胞周期定义为细胞从上一次分裂结束开始，到下一次分裂结束为止的全过程（G1-S-G2-M）。' },
  { m: '医学细胞生物学|MPF', v: 'B', c: 'high', b: 'MPF（成熟促进因子，CyclinB-CDK1）驱动细胞从G2期进入M期。G1→S由CDK2-cyclinE等控制。' },
  { m: '医学细胞生物学|对细胞衰老起决定作用的是', v: 'B', c: 'mid', b: '核移植实验（将衰老细胞核移入年轻去核胞质）显示衰老表型由**细胞核**决定（端粒/基因表达程序），细胞核起决定作用。' },
  { m: '诊断学|肋脊角叩痛一般不见于', v: 'A', c: 'mid', b: '肋脊角叩击痛（肾区叩击痛）见于肾脏实质/肾周围炎症、结石、结核、肾盂肾炎等；游走肾（肾下垂）一般不引起肾区叩击痛。' },
  { m: '外基|创伤后人体代谢变化为', v: 'A', c: 'high', b: '创伤应激下分解代谢增强：蛋白分解↑、糖异生↑、脂肪分解↑（并伴胰岛素抵抗、负氮平衡）。' },
  { m: '外基|术中发生支气管痉挛伴低血压时', v: 'C', c: 'mid', b: '低血压状态下不宜加深麻醉（会进一步抑制循环、加重低血压），故"加深麻醉"应除外；其余（纯氧吸入、支气管扩张药、糖皮质激素）均为紧急处理措施。' },
  { m: '医学微生物学|1.什么试验 2.哪一个是阳性', amb: 'imageMissing' },
  { m: '医学微生物学|什么微生物', amb: 'imageMissing' },
  { m: '医学微生物学|什么细菌', amb: 'imageMissing' },
  { m: '医学遗传学|进行家系分析时必须注意的遗传学问题', v: 'E', c: 'high', b: '外显不全/延迟显性、新突变与易位基因、动态突变与基因组印迹、主基因与遗传背景及环境综合作用，均属家系分析须注意的问题，故选"以上都是"。' },
  { m: '马克思主义原理|区分量变和质变的根本标志', v: 'C', c: 'high', b: '区分量变质变的根本标志是事物的变化是否**超出度的范围**；速度与平稳性均非判据。' },
  { m: '内科学|易发生幽门梗阻的溃疡是', v: 'D', c: 'high', b: '幽门管溃疡位置在幽门管，易致幽门梗阻（并可无典型节律性疼痛）；球后溃疡易出血。依据《内科学》消化性溃疡章节。' },
  { m: '内科学|肝癌最常见的死亡原因是', v: 'E', c: 'high', b: '原发性肝癌最常见的死亡原因为**肝性脑病**（约占死亡1/3，多继发于肝硬化与肝功能衰竭）；上消化道出血、肝癌结节破裂出血、继发感染为其他并发症。' },
  { m: '内科学|小肝癌是指孤立癌灶直径', v: 'D', c: 'high', b: '小肝癌定义：单个癌结节直径≤3cm，或两个癌结节直径之和≤3cm。故"＜3cm"。' },
  { m: '精神病学|对神经性厌食患者的治疗原则是', v: 'D', c: 'high', b: '神经性厌食救治首要是纠正营养不良与水电解质紊乱（可危及生命），同时或稍后开展心理治疗并辅以药物。' },
  { m: '精神病学|关于精神分裂症的焦虑、抑郁症状', v: 'B', c: 'mid', b: '精神分裂症的焦虑抑郁症状多见于急性期/以**阳性症状**为主者（及缓解后期），"以阴性症状为主的患者较多出现"为错误表述，故选B。' },
  { m: '医学微生物学|最可能的诊断是', amb: 'caseMissing' },
  { m: '传染病学|地方性斑疹伤寒的传播媒介是', v: 'B', c: 'high', b: '地方性（鼠型）斑疹伤寒由莫氏立克次体经**鼠蚤**传播；流行性斑疹伤寒才是人虱传播。' },
  { m: '儿科学|左向右分流型先天性心脏病出现显著肺动脉高压时', v: 'A', c: 'mid', b: '左向右分流（ASD/VSD/PDA）长期肺血增多致肺血管阻力升高，显著肺动脉高压后以**右心室增大**为主，左房/左室增大反而减轻。' },
  { m: '儿科学|下列食物中，铁的良好来源', v: 'A', c: 'high', b: '铁的良好来源为**动物肝脏、动物血、瘦肉**（血红素铁，吸收率15%~20%）；鱼、蛋黄、大豆、小麦的吸收率低。' },
  { m: '内科学|可释放组胺引起哮喘等超敏反应的白细胞', v: 'E', c: 'high', b: '嗜碱性粒细胞含组胺、白三烯等，是Ⅰ型超敏反应的关键效应细胞（肥大细胞同源）。' },
  { m: '内科学|左下腹痛2个月，黄稀便', v: 'C', c: 'high', b: '直肠+乙状结肠连续性、弥漫性糜烂及浅溃疡伴充血水肿，典型溃疡性结肠炎内镜表现（克罗恩病为节段性/纵行溃疡/鹅卵石）。' },
  { m: '诊断学|区别血红蛋白尿与血尿的主要方法', v: 'D', c: 'high', b: '**尿沉渣镜检**：血尿可见红细胞（离心后上清转清），血红蛋白尿无红细胞而尿色仍呈浓茶/酱油色。' },
  { m: '诊断学|克雷伯杆菌引起的尿路感染', v: 'E', c: 'mid', b: '革兰阴性杆菌尿路感染的临床诊断阈值为清洁中段尿培养菌落计数≥10⁵个/ml（此时特异度最高）。A项"＜1000"为污染范围。' },
  { m: '内科学|促进胰岛素分泌的药物是', v: 'C', c: 'high', b: '格列齐特为磺脲类，直接促进胰岛β细胞分泌胰岛素；二甲双胍抑制肝糖输出，罗格列酮/吡格列酮为TZD增敏剂，阿卡波糖为α-糖苷酶抑制剂。' },
  { m: '医学伦理学|心理治疗的伦理要求是', v: 'C', c: 'mid', b: '心理治疗要求医师"以健康、稳定的情绪影响患者"（避免移情/情绪污染）；A、B属外科/协作伦理，D属用药伦理，E属康复伦理。' },
  { m: '预防医学|健康管理的首要步骤一般是', v: 'A', c: 'high', b: '健康管理流程：**收集健康信息**→健康风险评估→制订健康维护计划→实施与跟踪。' },
  { m: '医学免疫学|两种以上的细胞因子发挥同样或类似的生物学作用', v: 'A', c: 'high', b: '细胞因子的**重叠性**：多种因子作用于同一靶细胞产生相同或相似效应。协同性是效应叠加增强，拮抗性是相互抑制。' },
  { m: '医学微生物学|念珠菌性阴道炎', v: 'A', c: 'mid', b: '白色念珠菌在沙氏培养基上形成**假菌丝与芽生孢子**，不产生"带有分生孢子的气生菌丝体"（那是丝状真菌）；革兰染色可见芽生酵母型菌，B/C/E也均是合理提示。故最不正确为A。' },
  { m: '医学心理学|行为主义理论的治疗观点', v: 'B', c: 'high', b: '行为主义以条件反射/学习理论为基础，治疗即"矫正不良行为习惯、消除病理性条件反射"；A属精神分析，C属认知疗法，D属人本主义。（题干"符台"为"符合"OCR讹字）' },
  { m: '预防医学|在判断因果联系的标准中，存在剂量-反应关系表明', v: 'E', c: 'high', b: '剂量-反应关系指随暴露剂量增减，联系强度相应增减，是因果关联的重要依据。' },
  { m: '预防医学|在病因研究中，常见的偏倚有', v: 'ABC', c: 'high', b: '流行病学三大常见偏倚：**选择偏倚、信息偏倚、混杂偏倚**；测量偏倚属信息偏倚子类，文献偏倚非标准分类。' },
  { m: '诊断学|维生素K缺乏时，不会出现的实验室检查结果', v: 'B', c: 'high', b: '维生素K缺乏致Ⅱ、Ⅶ、Ⅸ、Ⅹ因子合成减少 → PT延长、APTT延长、CT延长、INR升高；**FDP增加反映纤溶亢进**，与维生素K缺乏无关。' },
  { m: '生理学|血浆蛋白浓度降低所致水肿的原因是', v: 'E', c: 'high', b: '血浆蛋白（尤其白蛋白）减少 → **血浆胶体渗透压降低** → 有效滤过压升高 → 组织液生成增多致水肿。' },
  { m: '组织学与胚胎学|幼年时生长激素分泌过多会导致', v: 'E', c: 'high', b: '骨骺未闭合（幼年）时GH过多 → 巨人症；骨骺闭合后 → 肢端肥大症；分泌不足 → 侏儒症。' },
  { m: '病理学|在我国最多见的淋巴瘤类型是', v: 'B', c: 'high', b: '我国及全球最常见者为**弥漫性大B细胞淋巴瘤（DLBCL）**。依据《病理学》（人卫第9版）淋巴造血系统疾病。' },
  { m: '内科学|请判读下列心电图并作出诊断', amb: 'imageMissing' },
  { m: '生理学|箭外翻的颈角范围是', v: 'A', c: 'mid', b: '题中"箭外翻"为"髋外翻"OCR 讹字。颈干角正常 110°~140°；**髋外翻 = 颈干角 >140°**（髋内翻 = <110°）。' },
];

// ---------- 应用 ----------
const RULES = [...new Map(SINGLE.map(x => [x.m, x])).values()]; // 去重
const single = rd('conflicts_manual_single_source.json');
const cross = rd('conflicts_manual_cross_source.json');
const applied = [];
const overrides = {};

for (const c of single) {
  const sN = String(c.stem).replace(/\s+/g, '');
  const hit = RULES.find(x => {
    const [sub, frag] = x.m.split('|');
    return c.subject === sub && sN.includes(frag.replace(/\s+/g, ''));
  });
  const rec = {
    subject: c.subject, type: c.type, stem: c.stem.slice(0, 120),
    options: c.options,
    candidates: c.answers.map(a => `${a.originGroup}=${a.answer}`),
    mainAnswer: c.mainAnswer, mainOrigin: c.mainOrigin
  };
  if (!hit) {
    rec.verdict = null; rec.status = 'unresolved-auto';
    rec.note = '未匹配裁决表，保留 mainAnswer 并标 answerAmbiguity';
    applied.push(rec); continue;
  }
  hit._used = true;
  if (hit.amb) {
    rec.verdict = null; rec.status = 'ambiguous';
    rec.ambiguityReason = hit.amb === 'imageMissing' ? '图片题（选项/题图依赖原图，文本层不可裁决）' : '病例题干缺失（A2/A3 病例正文未随题保存，不可裁决）';
    rec.action = '保留 mainAnswer，标 flags.imageMissing / answerAmbiguity=true，网站提示"此题源数据存在分歧"';
  } else {
    rec.verdict = hit.v; rec.status = rec.mainAnswer === hit.v ? 'confirmed' : 'overridden';
    rec.confidence = hit.c; rec.basis = hit.b;
    rec.action = rec.mainAnswer === hit.v ? '维持主答案' : `改判 ${c.mainAnswer} → ${hit.v}`;
    if (rec.mainAnswer !== hit.v) overrides[c.dupKey] = { from: c.mainAnswer, to: hit.v, basis: hit.b, confidence: hit.c, subject: c.subject };
  }
  applied.push(rec);
}
const unmatched = [];
for (const x of RULES) if (!x._used) unmatched.push(x);

// 跨来源 6 组（v2 口径：5 组已拆解，仅第 6 组仍为冲突）
const crossApplied = CROSS.map(x => {
  const still = x.v2Stem ? cross.find(c => String(c.stem).replace(/\s+/g, '').includes(x.v2Stem.replace(/\s+/g, ''))) : null;
  return {
    no: x.no, subject: x.subject, stem: x.stem, claim: x.claim,
    verdict: x.verdict, verdictType: x.verdictType, confidence: x.confidence,
    basis: x.basis, action: x.action,
    v2StillConflict: !!still,
    v2Rule: still ? still.decision.rule : null,
    v2Decision: still ? still.decision.answer : null
  };
});

wr('conflicts_resolved_manual.json', {
  generatedAt: new Date().toISOString(),
  mergeBasis: 'merged2（v2 合并键：病例摘要+题干+选项指纹，并做 Jaccard≥0.75 模糊合并）',
  summary: {
    groups: crossApplied.length,
    trulyConflicting: crossApplied.filter(x => x.v2StillConflict).length,
    falseConflict: crossApplied.filter(x => !x.v2StillConflict).length,
    note: '回原始 iyixue/极光 分片逐条核验选项集合后：5 组的"分歧"实为**小问题干相同的不同题目**或**同年份不同选项版本**，并非答案分歧；仅第 6 组（病理学·良性肿瘤，2006 版）为同一选项集下的真答案分歧。'
  },
  groups: crossApplied
});

wr('conflicts_single_source_resolved.json', {
  generatedAt: new Date().toISOString(),
  mergeBasis: 'merged2 单来源需人工 53 组（v1 为 289 组，其中 236 组经选项指纹拆分后消失）',
  summary: {
    total: applied.length,
    confirmed: applied.filter(x => x.status === 'confirmed').length,
    overridden: applied.filter(x => x.status === 'overridden').length,
    ambiguous: applied.filter(x => x.status === 'ambiguous').length,
    unresolved: applied.filter(x => x.status === 'unresolved-auto').length,
    unmatchedRule: unmatched.length
  },
  note: [
    '规则：以人卫第9/10版对应教材 + 权威指南为准逐题裁决；低置信度不硬改，改为标记。',
    'overridden = 主答案与教材结论冲突，已改判并记入 answer_overrides.json。',
    'ambiguous = 图片题或病例正文缺失，文本层不可裁决 → 保留原答案并加 answerAmbiguity 标记，不删任何分歧版本。'
  ],
  items: applied
});

wr('answer_overrides.json', {
  generatedAt: new Date().toISOString(),
  note: 'key = merged2 dupKey（病例摘要+题干+选项指纹 归一化）；value = 教材裁决后的正确答案。用于二次写回或校对。',
  count: Object.keys(overrides).length,
  overrides
});

console.log('跨来源 6 组：真冲突', crossApplied.filter(x => x.v2StillConflict).length, '/ 伪冲突', crossApplied.filter(x => !x.v2StillConflict).length);
console.log('单来源 53 组：维持', applied.filter(x => x.status === 'confirmed').length,
  '| 改判', applied.filter(x => x.status === 'overridden').length,
  '| 不可裁决(标记)', applied.filter(x => x.status === 'ambiguous').length,
  '| 未匹配', applied.filter(x => x.status === 'unresolved-auto').length);
if (unmatched.length) console.log('未用到的裁决条目:', JSON.stringify(unmatched.map(u => u.m)));
