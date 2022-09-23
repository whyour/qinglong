export default function browserType() {
  // 权重：系统 + 系统版本 > 平台 > 内核 + 载体 + 内核版本 + 载体版本 > 外壳 + 外壳版本
  const ua = navigator.userAgent.toLowerCase();
  const testUa = (regexp: RegExp) => regexp.test(ua);
  const testVs = (regexp: RegExp) =>
    (ua.match(regexp) || [])
      .toString()
      .replace(/[^0-9|_.]/g, '')
      .replace(/_/g, '.');

  // 系统
  let system = 'unknow';
  if (testUa(/windows|win32|win64|wow32|wow64/g)) {
    system = 'windows'; // windows系统
  } else if (testUa(/macintosh|macintel/g)) {
    system = 'macos'; // macos系统
  } else if (testUa(/x11/g)) {
    system = 'linux'; // linux系统
  } else if (testUa(/android|adr/g)) {
    system = 'android'; // android系统
  } else if (testUa(/ios|iphone|ipad|ipod|iwatch/g)) {
    system = 'ios'; // ios系统
  }

  // 系统版本
  let systemVs = 'unknow';
  if (system === 'windows') {
    if (testUa(/windows nt 5.0|windows 2000/g)) {
      systemVs = '2000';
    } else if (testUa(/windows nt 5.1|windows xp/g)) {
      systemVs = 'xp';
    } else if (testUa(/windows nt 5.2|windows 2003/g)) {
      systemVs = '2003';
    } else if (testUa(/windows nt 6.0|windows vista/g)) {
      systemVs = 'vista';
    } else if (testUa(/windows nt 6.1|windows 7/g)) {
      systemVs = '7';
    } else if (testUa(/windows nt 6.2|windows 8/g)) {
      systemVs = '8';
    } else if (testUa(/windows nt 6.3|windows 8.1/g)) {
      systemVs = '8.1';
    } else if (testUa(/windows nt 10.0|windows 10/g)) {
      systemVs = '10';
    }
  } else if (system === 'macos') {
    systemVs = testVs(/os x [\d._]+/g);
  } else if (system === 'android') {
    systemVs = testVs(/android [\d._]+/g);
  } else if (system === 'ios') {
    systemVs = testVs(/os [\d._]+/g);
  }

  // 平台
  let platform = 'unknow';
  if (system === 'windows' || system === 'macos' || system === 'linux') {
    platform = 'desktop'; // 桌面端
  } else if (system === 'android' || system === 'ios' || testUa(/mobile/g)) {
    platform = 'mobile'; // 移动端
  }

  // 内核和载体
  let engine = 'unknow';
  let supporter = 'unknow';
  if (testUa(/applewebkit/g)) {
    engine = 'webkit'; // webkit内核
    if (testUa(/edge/g)) {
      supporter = 'edge'; // edge浏览器
    } else if (testUa(/opr/g)) {
      supporter = 'opera'; // opera浏览器
    } else if (testUa(/chrome/g)) {
      supporter = 'chrome'; // chrome浏览器
    } else if (testUa(/safari/g)) {
      supporter = 'safari'; // safari浏览器
    }
  } else if (testUa(/gecko/g) && testUa(/firefox/g)) {
    engine = 'gecko'; // gecko内核
    supporter = 'firefox'; // firefox浏览器
  } else if (testUa(/presto/g)) {
    engine = 'presto'; // presto内核
    supporter = 'opera'; // opera浏览器
  } else if (testUa(/trident|compatible|msie/g)) {
    engine = 'trident'; // trident内核
    supporter = 'iexplore'; // iexplore浏览器
  }

  // 内核版本
  let engineVs = 'unknow';
  if (engine === 'webkit') {
    engineVs = testVs(/applewebkit\/[\d._]+/g);
  } else if (engine === 'gecko') {
    engineVs = testVs(/gecko\/[\d._]+/g);
  } else if (engine === 'presto') {
    engineVs = testVs(/presto\/[\d._]+/g);
  } else if (engine === 'trident') {
    engineVs = testVs(/trident\/[\d._]+/g);
  }

  // 载体版本
  let supporterVs = 'unknow';
  if (supporter === 'chrome') {
    supporterVs = testVs(/chrome\/[\d._]+/g);
  } else if (supporter === 'safari') {
    supporterVs = testVs(/version\/[\d._]+/g);
  } else if (supporter === 'firefox') {
    supporterVs = testVs(/firefox\/[\d._]+/g);
  } else if (supporter === 'opera') {
    supporterVs = testVs(/opr\/[\d._]+/g);
  } else if (supporter === 'iexplore') {
    supporterVs = testVs(/(msie [\d._]+)|(rv:[\d._]+)/g);
  } else if (supporter === 'edge') {
    supporterVs = testVs(/edge\/[\d._]+/g);
  }

  // 外壳和外壳版本
  let shell = 'none';
  let shellVs = 'unknow';
  if (testUa(/micromessenger/g)) {
    shell = 'wechat'; // 微信浏览器
    shellVs = testVs(/micromessenger\/[\d._]+/g);
  } else if (testUa(/qqbrowser/g)) {
    shell = 'qq'; // QQ浏览器
    shellVs = testVs(/qqbrowser\/[\d._]+/g);
  } else if (testUa(/ucbrowser/g)) {
    shell = 'uc'; // UC浏览器
    shellVs = testVs(/ucbrowser\/[\d._]+/g);
  } else if (testUa(/qihu 360se/g)) {
    shell = '360'; // 360浏览器(无版本)
  } else if (testUa(/2345explorer/g)) {
    shell = '2345'; // 2345浏览器
    shellVs = testVs(/2345explorer\/[\d._]+/g);
  } else if (testUa(/metasr/g)) {
    shell = 'sougou'; // 搜狗浏览器(无版本)
  } else if (testUa(/lbbrowser/g)) {
    shell = 'liebao'; // 猎豹浏览器(无版本)
  } else if (testUa(/maxthon/g)) {
    shell = 'maxthon'; // 遨游浏览器
    shellVs = testVs(/maxthon\/[\d._]+/g);
  }

  const result = Object.assign(
    {
      engine, // webkit gecko presto trident
      engineVs,
      platform, // desktop mobile
      supporter, // chrome safari firefox opera iexplore edge
      supporterVs,
      system, // windows macos linux android ios
      systemVs,
    },
    shell === 'none'
      ? {}
      : {
        shell, // wechat qq uc 360 2345 sougou liebao maxthon
        shellVs,
      },
  );

  console.log(
    "%c\n .d88b.  d888888b d8b   db  d888b  db       .d88b.  d8b   db  d888b  \n.8P  Y8.   `88'   888o  88 88' Y8b 88      .8P  Y8. 888o  88 88' Y8b \n88    88    88    88V8o 88 88      88      88    88 88V8o 88 88      \n88    88    88    88 V8o88 88  ooo 88      88    88 88 V8o88 88  ooo \n`8P  d8'   .88.   88  V888 88. ~8~ 88booo. `8b  d8' 88  V888 88. ~8~ \n `Y88'Y8 Y888888P VP   V8P  Y888P  Y88888P  `Y88P'  VP   V8P  Y888P  \n                                                                     \n                                                                     \n",
    'color: blue;font-size: 14px;',
  );
  console.log(
    '%c忘形雨笠烟蓑，知心牧唱樵歌。明月清风共我，闲人三个，从他今古消磨。\n',
    'color: yellow;font-size: 18px;',
  );
  console.log(
    `%c青龙运行环境:\n\n系统：${result.system}/${result.systemVs}\n浏览器：${result.supporter}/${result.supporterVs}\n内核：${result.engine}/${result.engineVs}`,
    'color: green;font-size: 14px;font-weight: bold;',
  );

  return result;
}

/**
 * 获取第一个表格的可视化高度
 * @param {*} extraHeight 额外的高度(表格底部的内容高度 Number类型,默认为74)
 * @param {*} id 当前页面中有多个table时需要制定table的id
 */
export function getTableScroll({
  extraHeight,
  id,
}: { extraHeight?: number; id?: string } = {}) {
  if (typeof extraHeight == 'undefined') {
    //  47 + 40 + 12
    extraHeight = 99;
  }
  let tHeader = null;
  if (id) {
    tHeader = document.getElementById(id)
      ? document
        .getElementById(id)!
        .getElementsByClassName('ant-table-thead')[0]
      : null;
  } else {
    tHeader = document.querySelector('.ant-table-wrapper');
  }

  //表格内容距离顶部的距离
  let mainTop = 0;
  if (tHeader) {
    mainTop = tHeader.getBoundingClientRect().top;
  }

  //窗体高度-表格内容顶部的高度-表格内容底部的高度
  let height = document.body.clientHeight - mainTop - extraHeight;
  return height;
}

// 自动触发点击事件
function automaticClick(elment: HTMLElement) {
  const ev = document.createEvent('MouseEvents');
  ev.initMouseEvent(
    'click',
    true,
    false,
    window,
    0,
    0,
    0,
    0,
    0,
    false,
    false,
    false,
    false,
    0,
    null,
  );
  elment.dispatchEvent(ev);
}

// 导出文件
export function exportJson(name: string, data: string) {
  const urlObject = window.URL || window.webkitURL || window;
  const export_blob = new Blob([data]);
  const createA = document.createElementNS(
    'http://www.w3.org/1999/xhtml',
    'a',
  ) as any;
  createA.href = urlObject.createObjectURL(export_blob);
  createA.download = name;
  automaticClick(createA);
}

export function depthFirstSearch<
  T extends Record<string, any> & { children?: T[] },
>(children: T[], condition: (column: T) => boolean, item?: T) {
  const c = [...children];
  const keys = [];

  (function find(cls: T[] | undefined) {
    if (!cls) return;
    for (let i = 0; i < cls?.length; i++) {
      if (condition(cls[i])) {
        if (!item) {
          cls.splice(i, 1);
          return;
        }

        if (cls[i].children) {
          cls[i].children!.unshift(item);
        } else {
          cls[i].children = [item];
        }
        return;
      }
      if (cls[i].children) {
        keys.push(cls[i].key);
        find(cls[i].children);
      }
    }
  })(c);

  return c;
}
