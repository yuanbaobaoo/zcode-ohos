import { hapTasks } from '@ohos/hvigor-ohos-plugin';

// HNP 插件暂缓启用：HarmonyOS 7.0 上随 HAP 安装 electron.hnp 报 9568407
// （installing the native package failed），先以应用本体直装做装机冒烟。
// 恢复方法：取消下方注释，并恢复 module.json5 中的 hnpPackages 段。
// import { HnpPlugin } from '../hvigor/plugin/hnp-plugin';

export default {
    system: hapTasks,  /* Built-in plugin of Hvigor. It cannot be modified. */
    plugins: [
        // new HnpPlugin(),
    ]
}
