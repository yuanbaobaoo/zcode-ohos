import { appTasks } from '@ohos/hvigor-ohos-plugin';

// ZCode OHOS 应用工程。
// resfile/resources/app 的内容由仓库根目录 scripts/build-ohos.mjs 在 hvigor 构建
// 之前从 ZCode 源码构建产物组装（应用本体，非预打包载荷），hvigor 只负责标准 HAP 组装。
export default {
  system: appTasks,
  plugins: [],
};
