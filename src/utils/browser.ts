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

  console.log(result);
  return result;
}
