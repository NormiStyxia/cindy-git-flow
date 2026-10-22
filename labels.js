(function (scope) {
  'use strict';
  const types = { feat: '新增功能', fix: '修复问题', style: '样式调整', merge: '合并更新', docs: '文档更新', chore: '维护整理', perf: '性能优化', refactor: '代码整理', test: '测试更新', art: '美术更新', tune: '参数调整', tweak: '细节调整', revert: '撤销提交', build: '构建更新', ci: '自动化更新' };
  const areas = { story: '剧情', input: '输入控制', camera: '镜头', ui: '界面', salvage: '搜打撤', combat: '战斗', battle: '战斗', tutorial: '新手引导', drive: '驾驶', plugins: '插件', vehicle: '载具', nono: '诺诺', audio: '音频', vanguard: '先锋', drills: '钻头', pvp: '对战', mech: '机甲', mechleg: '机甲腿', intro: '开场', navigator: '领航员', brand: '品牌', endless: '无尽模式', 'endless P0': '无尽模式第零阶段', 'battle-tab': '战斗页', 'match-intro': '对局开场' };
  // 已核对的中文释义仅用于显示，提交记录、分支名和作者名始终保留原值。
  const descriptions = {
    'add initial MVP cinematic and quick preview': '添加首版原型过场动画和快速预览',
    'filter isolated pointer-lock mouse spikes': '过滤鼠标锁定模式下偶发的移动量突增',
    'add chassis stabilization and rounded track colliders': '添加底盘稳定控制和圆角履带碰撞体',
    'integrate story background grid while preserving local voice and scaling': '合入剧情背景网格，保留本地配音和缩放改动',
    'integrate mobile touch controls while preserving local gameplay updates': '合入移动端触控，保留本地玩法改动',
    'add mobile touch controls across gameplay': '为游戏操作添加移动端触控',
    'unify resolution scaling and prevent legacy theme fallback': '统一不同分辨率的界面缩放，修复旧主题回退问题',
    'add enemy destruction explosions and distance-based camera shake': '添加敌人被摧毁时的爆炸，以及按距离变化的镜头震动',
    'replace contract stamp with generated company seal': '用生成的公司印章替换合同印章',
    'trial story enemy execution thresholds and stronger gatling feedback': '试调剧情敌人的处决阈值，增强加特林开火反馈',
    'offer battle-first onboarding and build lesson replay': '添加先体验战斗的新手引导，以及建造教学回放',
    'improve tracked vehicle grip, weight and steering feel': '改善履带载具的抓地力、重量感和转向手感',
    'preserve removable packages on accepted remote core': '在已采用的远端核心版本上保留可移除插件包',
    'align with remote salvage core and adopt Nono tutorial': '对齐远端搜打撤核心，采用诺诺的新手教学',
    'retain canyon camera, wheel grip and HUD performance improvements': '保留峡谷镜头、车轮抓地力和仪表界面性能改进',
    'preserve bridge approaches and signed baked road distances': '保留桥梁引道和预计算道路距离的正负符号',
    'record latest remote baseline and story controls regression': '记录最新远端基线和剧情操作回归检查',
    'clear pending enemy views before leaving a run': '退出行动前清理待处理的敌人视图',
    'align salvage work with latest remote story and UI': '将搜打撤改动与最新远端剧情和界面对齐',
    'update core baseline with story hologram and HUD gauges': '将剧情全息效果和仪表界面纳入核心基线',
    'retain huhutest history for aligned salvage publication': '保留 huhutest 历史，用于发布对齐后的搜打撤版本',
    'add scavenger encounters, cinematics and baked terrain': '添加拾荒者遭遇、过场动画和预计算地形',
    'cache turret ranges during damage rebuilds': '在受损重建时缓存炮塔转动范围',
    'merge HUD reference ticks into functional gauges': '将界面参考刻度整合到实际仪表中',
    'add canyon terrain, loot and extraction gameplay': '添加峡谷地形、战利品和撤离玩法',
    'align removable add-ons with latest UI and salvage core': '将可移除扩展与最新界面和搜打撤核心对齐',
    'align assistant add-ons with latest core and UI': '将助手扩展与最新核心和界面对齐',
    'combine latest salvage core and approved UI baseline': '合并最新搜打撤核心与已确认的界面基线',
    'scale hangar from reference canvas and restore HUD frame': '按参考画布缩放机库，恢复仪表界面框架',
    'simplify driving HUD and add entry titles': '简化驾驶仪表界面，添加入口标题',
    'refine hangar spacing and workshop controls': '调整机库间距和工坊控件',
    'adopt approved B dot relief and responsive layouts': '采用已确认的 B 方案点阵浮雕和自适应布局',
    'withdraw unsolicited agent instruction update': '撤回未经要求的助手指令更新',
    'save approved industrial relief study and non-story theme baseline': '保存已确认的工业浮雕方案和非剧情页面主题基线',
    'simplify audio settings helper text': '精简音频设置的说明文字',
    'add voice volume controls and battle communication subtitles': '添加语音音量控制和战斗通讯字幕',
    'integrate b90a329 story and audio updates': '合入 b90a329 的剧情和音频更新',
    'refresh add-ons for latest salvage story and audio core': '更新扩展，适配最新搜打撤、剧情和音频核心',
    'install independent standard-block BT prefab': '接入独立的标准方块 BT 预制体',
    'install optional Huhu drill pack on salvage core': '在搜打撤核心上接入可选的狐狐钻头包',
    'package reversible Huhu add-ons for salvage core': '为搜打撤核心打包可撤回的狐狐扩展',
    'refine hangar hierarchy and preserve approved controls': '调整机库信息层级，保留已确认的控件',
    'CoD-style battlefield announcer — Nono radio callouts for mode title, rounds/phases, kills/streaks, points/shields, cart, results (118 lines, variants, priority queue, cooldowns)': '添加类似使命召唤的战场播报：诺诺播报模式、回合、击杀、据点、护盾、推车和结果；含 118 条台词、变体、优先队列和冷却',
    'integrate blue industrial hangar and parts library': '整合蓝色工业风机库和零件库',
    'head mask set that assembles into one complete head (helmet w/ visor slot + brow, face guard w/ vents, L/R jaws, L/R ears w/ emblem + fin) + own shield language (raised hex crystals over glowing seams, two-tone frame, graphite/orange mount) + 6 large plates (pauldron, chest, wing, skirt, back, armguard)': '制作可组装的完整机甲头部（头盔、眉部、面罩、左右下颌与耳部），设计凸起六边形晶体、发光接缝、双色框架和石墨橙色支架的护盾，以及肩、胸、翼、裙、背、臂六类装甲板',
    'standalone decor kit — one-mesh folded electroplates (fold/crease generator, recessed hex shield face, rim, mount foot) + lofted mask pieces (helmet hood, face plate, jaw, ear)': '制作独立装饰套件：带折叠生成器、凹陷六边形盾面、边框和安装脚的单网格电镀板，以及放样生成的头盔、面罩、下颌和耳部',
    'inverted-trapezoid chest + thin shoulders; big modular decor pass (polygon electroplate shards incl. standing double-sided fins, layered pauldrons, gorget, reactor hex, weapon mount rings, vents, sensors, thruster pods, emblems, hazard stripes, 07 decals, mech mask head)': '调整倒梯形胸部和薄肩，扩充模块化装饰：双面翼片、分层肩甲、护颈、反应堆、武器安装环、通风口、传感器、推进器舱、徽记、警示条纹、07 贴花和机甲面罩',
    'slimmer pelvis + modular decor kit in Blender (Robocraft-style electroplates: chamfered frame, recessed backing, 3D hex cells on posts, angled; mech mask head: visor nose, jaws, ears with hex emblem)': '在 Blender 中收窄骨盆并制作模块化装饰：带倒角框架、凹陷背板和立体六边形单元的电镀板，以及面罩鼻部、下颌和徽记耳部',
    'less top-heavy mega mech (narrower/shorter torso and shoulders, wider leg stance, wider pelvis with heavy side skirts)': '减轻巨型机甲头重脚轻的感觉：缩窄缩短躯干与肩部，加宽站姿和带厚侧裙的骨盆',
    'mega mech block base as game blueprint using all block kinds (slopes/corners/round/cut chamfers, heavy+neon, struts, cylinders, shields, decor), exported 1:1 with game models into Blender': '使用斜面、转角、圆角、倒角、重型、霓虹、支杆、圆柱、护盾和装饰方块构建巨型机甲蓝图，按游戏模型 1:1 导出到 Blender',
    'mega mech in Blender at game scale (chamfered polygonal torso/shoulders/head, nano-shield hex cells, side-mounted laser5/mg5 fully seated, missile5 on back pad)': '在 Blender 中按游戏比例制作巨型机甲：倒角躯干、肩和头部、六边形纳米盾、完整安装的侧置 laser5/mg5，以及背部 missile5',
    'rebuild mega mech blockout Robocraft-style (single cubes, side-mounted shoulder weapons with clear turret sweep, compact torso on paired mech5 legs)': '按 Robocraft 风格重做巨型机甲草模：独立方块、留出炮塔转动空间的侧肩武器，以及双 mech5 腿上的紧凑躯干',
    'mega mech blockout as a real game blueprint (2x mech5, laser5, mg5, missile5; thin joined-block shell within T5 limits)': '将巨型机甲草模制成实际游戏蓝图：双 mech5 腿、laser5、mg5、missile5，以及符合 T5 限制的薄方块外壳',
    'new mode/map art generated from real in-game frames (Nano Banana + Seedream), less AI look': '基于实际游戏画面生成新模式和地图美术（Nano Banana 与 Seedream），减少人工智能生成的视觉痕迹',
    'T3–T5 reverse-knee light mech legs in game + faster handling + aim-relative driving': '接入 T3–T5 反关节轻型机甲腿，加快操控响应，支持相对瞄准方向驾驶',
    'softer radio voice (wider band, de-harsh dip, compressor, no distortion)': '柔化无线电语音：拓宽频带、降低刺耳频段、压缩动态并去掉失真',
    'drop radio key-up/key-down sounds': '移除无线电按键按下和松开的音效',
    "re-record Nono's thruster line (old take was distorted)": '重新录制诺诺的推进器台词，替换失真的旧录音',
    'Nono replaces Vivi (P5-style portraits + expressions, full re-voiced intro lines), radio-style voiced match briefings, new company/division logos in the opening film and lobby': '用诺诺替换薇薇：更新立绘与表情、重录开场台词，添加无线电式对局简报，以及开场和大厅的新公司与部门标志',
    'new navigator portrait (P5-style ink, division arm patch, fixed hand, no chest logo) + turnaround': '制作领航员新立绘和转面图：P5 风格墨线、部门臂章、修正手部并去掉胸口标志',
    'company + Special Security Division logos as transparent game assets (emblem, lockup, dark-UI variants)': '制作公司与特别安保部门的透明标志素材：徽章、组合标志和深色界面版本',
    'no free-roam toast in matches; Tab board / capture panel animate in place': '移除对局中的自由探索提示，让计分板和占点面板在原位播放动画',
    'match intro (map flyover + navigator briefing + squad showcase), Valorant-style HUD/banners/scoreboard, new elimination rules (regen + sudden death), 3-node capture points, red enemy glow, amber blocked-aim marker': '添加对局开场（地图飞越、领航员简报、队伍展示）、无畏契约风格仪表界面与计分板、回复和突然死亡规则、三节点占点、红色敌人光效与琥珀色瞄准受阻标记',
    'full-screen matchmaking page (animated mechanic emblem, team cards with avatars, map banner) + generated concept art for mode cards and map': '添加全屏匹配页：动态机械徽章、头像队伍卡和地图横幅，并生成模式卡与地图概念美术',
    'battle tab top bar sits on the map art; car chip + start button as one slanted unit': '将战斗页顶栏放在地图美术上，把载具标签和开始按钮合成一个斜角组件',
    'rebuild battle tab as AAA-style mode select (big in-game key-art cards left, map showcase right)': '重做大型游戏风格的模式选择页：左侧放游戏画面大卡，右侧展示地图',
    'escort contest by headcount, earlier decider (1:15) and bot push; full-match runs': '护送争夺改按人数判定，提前至 1 分 15 秒决胜并让机器人推车，完成整局运行检查',
    'bot-filled PvP modes (elimination / conquest / escort) with fake matchmaking': '添加机器人填充的淘汰、征服和护送对战模式，以及模拟匹配流程',
    'sustain drill advance and damage through rebuilt armor': '让钻头在装甲重建后继续推进并造成伤害',
    'spread Tianyuan drill damage over one second after impact': '将天元钻头撞击后的伤害分摊到一秒内',
    'integrate local drill designs with endless mode': '将本地钻头设计接入无尽模式',
    'opening recruitment-ad animation (WIP) + temporary hub button': '添加尚在制作中的招聘广告开场动画，以及临时大厅按钮',
    'missile pod, endless-mode refits and supporting fixes (WIP)': '添加尚在制作中的导弹舱、无尽模式整备和配套修复',
    'tune survival loop and record acceptance evidence': '调整生存流程并记录验收证据',
    'sync Blender map and baked giant corridor assets': '同步 Blender 地图与预计算巨型走廊素材',
    'P5 pause battles for limited-stock refits and resume saved runs': '第五阶段：暂停战斗进行限库存整备，再恢复保存的行动',
    'P4 add surviving-part drops and supply choices': '第四阶段：添加完好零件掉落和补给选择',
    'P3 add waves, base shields, lives and result flow': '第三阶段：添加波次、基地护盾、生命次数和结算流程',
    'P2 add enemy driving, combat and tiered prefabs': '第二阶段：添加敌人驾驶、战斗和分级预制体',
    'P1 share player damage and preserve rebuilt weapon state': '第一阶段：共用玩家受损机制，保留重建后的武器状态',
    'P0 add giant launch pads and verified crater corridor': '第零阶段：添加巨型发射台和已验证的陨石坑走廊'
  };
  const plain = {
    'Integrate mech movement refinements and standard-block BT prefab': '合并更新：整合机甲移动改进和标准方块 BT 预制体',
    'Merge drill weapons into mech-leg with combat compatibility fixes': '合并更新：将钻头武器合入机甲腿版本，并修复战斗兼容问题',
    'Add Huhu pirate drill raiders with standoff charge AI and fling self-destruct': '新增功能：添加狐狐海盗钻头袭击者，支持保持距离后冲锋和抛飞自爆'
  };
  const translations = new Map();
  function loadTranslations(cache) {
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return;
    for (const [source, text] of Object.entries(cache)) if (source.length <= 1500 && typeof text === 'string' && text.length <= 3000 && /[\u3400-\u9fff]/u.test(text)) translations.set(source, text);
    while (translations.size > 600) translations.delete(translations.keys().next().value);
  }
  function needsTranslation(value) {
    const original = String(value || '');
    if (translations.has(original) || Object.hasOwn(plain, original) || /^Merge (remote-tracking )?branch '(.+)' into (.+)$/.test(original)) return false;
    const m = original.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$/s);
    if (m && Object.hasOwn(types, m[1])) {
      if (m[2] && !Object.hasOwn(areas, m[2]) && /[a-z]/i.test(m[2])) return true;
      if (Object.hasOwn(descriptions, m[4])) return false;
    }
    const body = m && Object.hasOwn(types, m[1]) ? m[4] : original;
    // 中文标题中的分支名、文件名和调试参数保留原值，不送去重写整句。
    if (/[\u3400-\u9fff]/u.test(body)) {
      const prose = body.replace(/[A-Za-z][A-Za-z0-9_]*(?:[-/._][A-Za-z0-9_]+)+/g, '').replace(/\?[A-Za-z0-9_-]+/g, '');
      return /\b[a-z]{2,}\s+[a-z]{2,}\b/i.test(prose);
    }
    return /\b(?:[a-z]{2,}|[A-Z][a-z]{2,})\b/.test(body);
  }
  function subject(value) {
    const original = String(value || '');
    // 部分模型保留了英文提交前缀，显示时仍统一翻译类型与已知模块。
    const display = translations.get(original) || original;
    if (Object.hasOwn(plain, display)) return plain[display];
    const merge = display.match(/^Merge (remote-tracking )?branch '(.+)' into (.+)$/);
    if (merge) return '合并更新：将' + (merge[1] ? '远端分支 ' : '分支 ') + merge[2] + ' 合入 ' + merge[3];
    const m = display.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?[:：]\s*(.*)$/s);
    if (!m || !Object.hasOwn(types, m[1])) return display;
    const area = m[2] ? '（' + (Object.hasOwn(areas, m[2]) ? areas[m[2]] : m[2]) + '）' : '';
    return types[m[1]] + area + (m[3] ? ' · 含不兼容变更' : '') + '：' + (Object.hasOwn(descriptions, m[4]) ? descriptions[m[4]] : m[4]);
  }
  function fileStatus(file) {
    if (file.conflict) return '冲突待处理';
    if (file.untracked || file.status === '??') return '未跟踪';
    const code = file.status || '';
    const changes = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型改变', U: '冲突' };
    return [...code].map((c, i) => changes[c] ? (i === 0 ? '已暂存' : '未暂存') + changes[c] : '').filter(Boolean).join('、') || '有改动';
  }
  scope.GitLabels = { subject, fileStatus, needsTranslation, loadTranslations };
  if (typeof module !== 'undefined') module.exports = scope.GitLabels;
})(typeof window !== 'undefined' ? window : globalThis);
