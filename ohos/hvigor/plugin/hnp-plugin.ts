/**
 * HNP 插件 - 为 OHOS Electron 提供 child_process.fork() 支持
 *
 * 功能：
 * 1. 自动从 web_engine/resfile 提取 electron 二进制，构建 HNP 包
 * 2. 运行时 monkey-patch DevEco 打包系统，注入 --hnp-path 参数
 * 3. 自动在 module.json5 中添加 hnpPackages 配置
 *
 * 设计原则：不修改 DevEco Studio 内部文件，全部在运行时 hook 完成。
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { HvigorPlugin, HvigorNode } from '@ohos/hvigor';

const PLUGIN_ID = 'hnp-plugin';
const HNP_NAME = 'electron';
const HNP_VERSION = '1.0';

export class HnpPlugin implements HvigorPlugin {
    pluginId = PLUGIN_ID;

    apply(node: HvigorNode): void | Promise<void> {
        const modulePath = node.getNodePath();
        const projectRoot = path.resolve(modulePath, '..');
        const hnpDir = path.resolve(projectRoot, 'hnp');
        const electronHnpPath = path.resolve(hnpDir, 'arm64-v8a', `${HNP_NAME}.hnp`);

        // ====================================================
        // 阶段 1: 构建 HNP 包（如果还不存在）
        // ====================================================
        if (!fs.existsSync(electronHnpPath)) {
            console.log(`[${PLUGIN_ID}] electron.hnp not found, creating...`);
            try {
                this.buildHnpPackage(projectRoot, hnpDir);
                console.log(`[${PLUGIN_ID}] electron.hnp created successfully.`);
            } catch (e) {
                console.error(`[${PLUGIN_ID}] Failed to build HNP package:`, e);
            }
        } else {
            console.log(`[${PLUGIN_ID}] electron.hnp already exists, skipping HNP build.`);
        }

        // ====================================================
        // 阶段 2: 确保 module.json5 包含 hnpPackages 配置
        // ====================================================
        const moduleJsonPath = path.resolve(modulePath, 'src', 'main', 'module.json5');
        this.ensureHnpConfigInModuleJson(moduleJsonPath);

        // ====================================================
        // 阶段 3: Monkey-patch PackingToolOptions，注入 --hnp-path
        // 
        // 直接在 apply() 时 patch，不依赖任务查找。
        // 当 PackageHap 任务在构建阶段运行时，会创建 PackingToolOptions 
        // 实例并调用 .build()，此时我们的 patch 已在原型上生效。
        // ====================================================
        this.patchPackingToolOptions(projectRoot);
    }

    // ================================================================
    // 构建 HNP 包
    // ================================================================
    private buildHnpPackage(projectRoot: string, hnpDir: string): void {
        // 源文件：web_engine 模块的 resfile
        const resfileDir = path.resolve(projectRoot, 'web_engine', 'src', 'main', 'resources', 'resfile');
        const hnpBinDir = path.resolve(hnpDir, 'bin', HNP_NAME);

        // 检查源文件是否存在
        if (!fs.existsSync(resfileDir)) {
            console.warn(`[${PLUGIN_ID}] resfile directory not found: ${resfileDir}`);
            console.warn(`[${PLUGIN_ID}] HNP package cannot be built. fork() may not work.`);
            console.warn(`[${PLUGIN_ID}] Ensure web_engine/src/main/resources/resfile/ contains the electron binary.`);
            return;
        }

        // 检查 electron 二进制是否存在
        const electronBin = path.resolve(resfileDir, 'electron');
        if (!fs.existsSync(electronBin)) {
            console.warn(`[${PLUGIN_ID}] electron binary not found at: ${electronBin}`);
            console.warn(`[${PLUGIN_ID}] HNP package cannot be built. fork() may not work.`);
            return;
        }

        // 创建 HNP 源目录结构
        fs.mkdirSync(hnpBinDir, { recursive: true });

        // 复制 electron 二进制
        fs.copyFileSync(electronBin, path.resolve(hnpBinDir, 'electron'));

        // 复制资源文件（可选，非必需但建议包含）
        const resourceFiles = [
            'chrome_100_percent.pak',
            'chrome_200_percent.pak',
            'icudtl.dat',
            'resources.pak',
            'snapshot_blob.bin',
            'v8_context_snapshot.bin'
        ];
        for (const file of resourceFiles) {
            const src = path.resolve(resfileDir, file);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.resolve(hnpBinDir, file));
            }
        }

	        // 复制 locales 目录
	        const localesSrcDir = path.resolve(resfileDir, 'locales');
	        if (fs.existsSync(localesSrcDir)) {
	            const localesDestDir = path.resolve(hnpBinDir, 'locales');
	            fs.mkdirSync(localesDestDir, { recursive: true });
	            for (const entry of fs.readdirSync(localesSrcDir)) {
	                const srcPath = path.resolve(localesSrcDir, entry);
	                if (fs.statSync(srcPath).isFile()) {
	                    fs.copyFileSync(srcPath, path.resolve(localesDestDir, entry));
	                }
	            }
	        }

	        // 复制共享库（libelectron.so 等），使 HNP 进程能独立运行
	        const libsSrcDir = path.resolve(projectRoot, 'electron', 'libs', 'arm64-v8a');
	        const libsDestDir = path.resolve(hnpDir, 'lib', 'arm64-v8a');
	        if (fs.existsSync(libsSrcDir)) {
	            fs.mkdirSync(libsDestDir, { recursive: true });
	            for (const entry of fs.readdirSync(libsSrcDir)) {
	                const srcPath = path.resolve(libsSrcDir, entry);
	                if ((entry.endsWith('.so') || entry.endsWith('.node')) && fs.statSync(srcPath).isFile()) {
	                    fs.copyFileSync(srcPath, path.resolve(libsDestDir, entry));
	                    console.log(`[${PLUGIN_ID}] Copied library: ${entry}`);
	                }
	            }
	        } else {
	            console.warn(`[${PLUGIN_ID}] Native libs directory not found: ${libsSrcDir}`);
	        }

		        // 复制 zcode-cli.cjs 到 HNP 的 bin 目录
		        const resAppDir = path.resolve(projectRoot, 'web_engine/src/main/resources/resfile/resources/app');
		        for (const file of ['zcode-cli.cjs', 'glob-polyfill.mjs']) {
	            const src = path.resolve(resAppDir, file);
	            const dst = path.resolve(hnpBinDir, file);
	            if (fs.existsSync(src)) {
	                fs.copyFileSync(src, dst);
	                console.log(`[${PLUGIN_ID}] Copied ${file} to HNP bin`);
	            }
	        }

	        // 打包 zsh 及其 ncurses 依赖：应用沙箱的 /bin 只有 toybox，
	        // 没有 zsh；HNP bin 目录对本应用可执行，是终端 shell 的载体。
	        const zshSrc = '/usr/bin/zsh';
	        if (fs.existsSync(zshSrc)) {
	            fs.copyFileSync(zshSrc, path.resolve(hnpBinDir, 'zsh'));
	            fs.chmodSync(path.resolve(hnpBinDir, 'zsh'), 0o755);
	            console.log(`[${PLUGIN_ID}] Copied zsh to HNP bin`);
	        } else {
	            console.warn(`[${PLUGIN_ID}] ${zshSrc} not found, terminal will fall back to /bin/sh`);
	        }
	        const zshLibsDestDir = path.resolve(hnpDir, 'lib', 'arm64-v8a');
	        fs.mkdirSync(zshLibsDestDir, { recursive: true });
	        for (const lib of ['libncursesw.so.6', 'libtinfo.so.6']) {
	            const src = path.resolve('/usr/lib', lib);
	            if (fs.existsSync(src)) {
	                fs.copyFileSync(src, path.resolve(zshLibsDestDir, lib));
	                console.log(`[${PLUGIN_ID}] Copied zsh dependency: ${lib}`);
	            }
	        }

        // elf-loader + brewbin 垫片副本：应用身份 exec 不了 brew 目录的二进制
	        // （符号链接不可跟随、实体文件 EPERM），loader 把目标 ELF 映射进匿名内存
	        // 执行，不 execve 目标文件（见 docs/03 §22 更正与 native/elf-loader/）。
	        // brewbin/<tool> 与 loader 是同一二进制的副本，按 argv[0] 进入垫片模式。
	        const loaderSrc = path.resolve(projectRoot, 'vendor', 'elfloader-ohos', 'loader');
	        if (fs.existsSync(loaderSrc)) {
	            fs.copyFileSync(loaderSrc, path.resolve(hnpBinDir, 'loader'));
	            fs.chmodSync(path.resolve(hnpBinDir, 'loader'), 0o755);
	            const brewbinDir = path.resolve(hnpBinDir, 'brewbin');
	            fs.mkdirSync(brewbinDir, { recursive: true });
	            for (const name of ['node', 'npm', 'npx', 'corepack', 'git', 'git-lfs', 'curl', 'python3', 'python', 'pip3', 'less', 'xz', 'bzip2', 'unzip', 'zip', 'rustc', 'sqlite3']) {
	                const dst = path.resolve(brewbinDir, name);
	                fs.copyFileSync(loaderSrc, dst);
	                fs.chmodSync(dst, 0o755);
	            }
	            console.log(`[${PLUGIN_ID}] Copied elf-loader + brewbin shims to HNP bin`);
	            // brew 工具的依赖库闭包（沙箱 ldso 命名空间拒绝从 ~/.harmonybrew
	            // 加载 .so；HNP lib 目录可达——zsh 的 ncurses 就是从这里加载的）。
	            // 升级 brew 工具后重跑：node tools/collect-brew-libs.mjs
	            const brewLibsSrc = path.resolve(projectRoot, 'vendor', 'brew-libs-ohos');
	            if (fs.existsSync(brewLibsSrc)) {
	                for (const lib of fs.readdirSync(brewLibsSrc)) {
	                    if (lib.includes('.so')) {
	                        fs.copyFileSync(path.resolve(brewLibsSrc, lib), path.resolve(zshLibsDestDir, lib));
	                    }
	                }
	                console.log(`[${PLUGIN_ID}] Copied brew lib closure to HNP lib`);
	            }
	        } else {
	            console.warn(`[${PLUGIN_ID}] vendor/elfloader-ohos/loader not found (build: sh native/elf-loader/build.sh)`);
	        }

	        // 创建 hnp.json 配置文件
        const hnpJson = {
            type: 'hnp-config',
            name: HNP_NAME,
            version: HNP_VERSION,
            install: {
                links: [
                    {
                        source: `/bin/${HNP_NAME}`,
                        target: HNP_NAME
                    }
                ]
            }
        };
        fs.writeFileSync(
            path.resolve(hnpDir, 'hnp.json'),
            JSON.stringify(hnpJson, null, 4),
            'utf-8'
        );

        // 查找 hnpcli 工具
        const hnpcliPath = this.findHnpcli();

	        // 创建输出目录（与源目录分离，避免 hnpcli 把输出嵌套回源目录）
	        const hnpOutputDir = path.resolve(projectRoot, 'temp', 'hnp-output', 'arm64-v8a');
	        fs.mkdirSync(hnpOutputDir, { recursive: true });
	        const hnpTargetFile = path.resolve(hnpOutputDir, `${HNP_NAME}.hnp`);

	        if (!hnpcliPath) {
	            // hnp 本质是 zip，用标准 zip -r 打包（defN，与能工作的旧包一致）。
	            // 注意：zip 会记录宿主 unix 权限，HMDFS 上 chmod 无效（常为 770/600），
	            // 安装器按记录权限解包会让应用拿不到执行位（spawn EACCES）——
	            // 所以打包后必须走 fixHnpPermissions 统一置 755。
	            const zipCandidates = [
	                '/storage/Users/currentUser/.harmonybrew/bin/zip',
	                'zip',
	            ];
	            const zipPath = zipCandidates.find(p => p === 'zip' || fs.existsSync(p));
	            if (!zipPath) throw new Error('hnpcli not found and no zip fallback available.');
	            const cmd = `"${zipPath}" -r "${hnpTargetFile}" hnp -x "hnp/arm64-v8a/*"`;
	            console.log(`[${PLUGIN_ID}] hnpcli not found, zip fallback: ${cmd}`);
	            execSync(cmd, { cwd: projectRoot, timeout: 120000, windowsHide: true });
	            if (!fs.existsSync(hnpTargetFile)) throw new Error('zip fallback produced no output.');
            this.fixHnpPermissions(hnpTargetFile);
	        } else {
	        // 运行 hnpcli pack（-o 是目录路径，不是文件路径）
	        const cmd = `"${hnpcliPath}" pack -i "${hnpDir}" -o "${hnpOutputDir}" -n ${HNP_NAME} -v ${HNP_VERSION}`;
	        console.log(`[${PLUGIN_ID}] Running: ${cmd}`);
	        
	        try {
	            const output = execSync(cmd, {
	                cwd: projectRoot,
	                timeout: 60000,
	                windowsHide: true
	            });
	            console.log(`[${PLUGIN_ID}] hnpcli output: ${output.toString().trim()}`);
	        } catch (e: any) {
	            if (fs.existsSync(hnpTargetFile)) {
	                console.log(`[${PLUGIN_ID}] hnpcli completed (output file exists).`);
	                if (e.stdout) console.log(`[${PLUGIN_ID}] stdout: ${e.stdout.toString().trim()}`);
	                if (e.stderr) console.log(`[${PLUGIN_ID}] stderr: ${e.stderr.toString().trim()}`);
	            } else {
	                throw new Error(`hnpcli failed: ${e.message}`);
	            }
	        }
	        }

	        // 复制打包结果到最终位置
	        const finalHnpPath = path.resolve(projectRoot, 'hnp', 'arm64-v8a', `${HNP_NAME}.hnp`);
	        fs.mkdirSync(path.dirname(finalHnpPath), { recursive: true });
	        fs.copyFileSync(hnpTargetFile, finalHnpPath);
	        console.log(`[${PLUGIN_ID}] HNP copied to: ${finalHnpPath}`);

        // 清理源文件（可选，保持 hnp 目录整洁）
        this.cleanupHnpSource(hnpDir);
    }

    // ================================================================
    // 查找 hnpcli.exe
    // ================================================================
    /**
     * zip 条目默认记录宿主文件权限，但 HMDFS 上 chmod 无效（权限常为 770/600），
     * 系统安装器按记录权限解包后应用 uid 落在 other → spawn EACCES。
     * 直接重写 zip 中央目录每个条目的 external attributes：目录/文件统一 0755。
     */
    private fixHnpPermissions(hnpFile: string): void {
        const b = fs.readFileSync(hnpFile);
        let eocd = -1;
        for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
            if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('fixHnpPermissions: EOCD not found');
        const count = b.readUInt16LE(eocd + 10);
        let off = b.readUInt32LE(eocd + 16);
        for (let n = 0; n < count; n++) {
            if (b.readUInt32LE(off) !== 0x02014b50) throw new Error('fixHnpPermissions: bad central header');
            const nameLen = b.readUInt16LE(off + 28);
            const extraLen = b.readUInt16LE(off + 30);
            const comLen = b.readUInt16LE(off + 32);
            const name = b.slice(off + 46, off + 46 + nameLen).toString();
            const perm = name.endsWith('/') ? 0o40755 : 0o100755;
            b.writeUInt32LE((perm << 16) >>> 0, off + 38);
            off += 46 + nameLen + extraLen + comLen;
        }
        fs.writeFileSync(hnpFile, b);
        console.log(`[${PLUGIN_ID}] Fixed zip permissions to 0755 (${count} entries)`);
    }

    private findHnpcli(): string | null {
        // 常见的 SDK toolchains 路径
        // 注意：hnpcli_build/out/hnpcli 不可用 —— 它产出 deflate64 条目，
        // 装机后文件权限错误（spawn EACCES），打包请走 zip fallback。
        const searchPaths = [
            'D:\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hnpcli.exe',
            'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hnpcli.exe',
        ];

        // 从 SDK 环境变量推导（DevEco 运行 hvigor 时会注入 DEVECO_SDK_HOME）
        const sdkHomes = [
            process.env.DEVECO_SDK_HOME,
            process.env.OHOS_SDK_HOME,
            process.env.HOS_SDK_HOME,
        ].filter((p): p is string => !!p);
        const relCandidates = [
            'toolchains/hnpcli',
            'default/openharmony/toolchains/hnpcli',
            'openharmony/toolchains/hnpcli',
            'toolchains/openharmony/toolchains/hnpcli',
            'default/harmonyos/toolchains/hnpcli',
            'harmonyos/toolchains/hnpcli',
        ];
        for (const home of sdkHomes) {
            for (const rel of relCandidates) {
                searchPaths.push(path.resolve(home, rel));
                if (process.platform === 'win32') {
                    searchPaths.push(path.resolve(home, rel + '.exe'));
                }
            }
        }

        for (const p of searchPaths) {
            if (fs.existsSync(p)) {
                console.log(`[hnp-plugin] Found hnpcli: ${p}`);
                return p;
            }
        }

        // 在 SDK 目录下递归搜索（限深度，防止遍历过慢）
        for (const home of sdkHomes) {
            try {
                const found = this.findFileRecursive(home, 'hnpcli', 4);
                if (found) {
                    console.log(`[hnp-plugin] Found hnpcli by recursive search: ${found}`);
                    return found;
                }
            } catch {
                // ignore search errors
            }
        }

        // 在 DevEco 应用沙箱内用 find 探测（插件运行在 DevEco 进程里，有读权限）
        const probeRoots = [
            process.env.HOME,
            '/storage/Users/currentUser/appdata/el2/base/com.huawei.devecostudio',
        ].filter((p): p is string => !!p);
        for (const root of probeRoots) {
            try {
                const out = execSync(
                    `find "${root}" -maxdepth 8 -name 'hnpcli*' -type f 2>/dev/null | head -5`,
                    { timeout: 30000, windowsHide: true }
                ).toString().trim();
                const first = out.split('\n')[0];
                if (first && fs.existsSync(first)) {
                    console.log(`[hnp-plugin] Found hnpcli by sandbox probe: ${first}`);
                    return first;
                }
            } catch {
                // probe failed, keep looking
            }
        }

        // 尝试从 PATH 环境变量查找
        try {
            const result = execSync('where hnpcli 2>nul || which hnpcli 2>/dev/null', {
                timeout: 5000,
                windowsHide: true
            });
            const found = result.toString().trim().split('\n')[0];
            if (found && fs.existsSync(found)) {
                return found;
            }
        } catch {
            // not found in PATH
        }

        // 全部失败，输出诊断信息便于定位
        console.warn(`[hnp-plugin] hnpcli probe failed. env: DEVECO_SDK_HOME=${process.env.DEVECO_SDK_HOME}` +
            ` OHOS_SDK_HOME=${process.env.OHOS_SDK_HOME} HOME=${process.env.HOME}` +
            ` PATH=${(process.env.PATH || '').slice(0, 300)} cwd=${process.cwd()}`);
        return null;
    }

    // 在指定目录下按文件名递归查找（限最大深度）
    private findFileRecursive(dir: string, fileName: string, maxDepth: number, depth: number = 0): string | null {
        if (depth > maxDepth || !fs.existsSync(dir)) {
            return null;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const entry of entries) {
            const fullPath = path.resolve(dir, entry.name);
            if (entry.isFile() && (entry.name === fileName || entry.name === fileName + '.exe')) {
                return fullPath;
            }
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const found = this.findFileRecursive(path.resolve(dir, entry.name), fileName, maxDepth, depth + 1);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    }

    // ================================================================
    // 清理 HNP 构建产物之外的源文件
    // ================================================================
	    private cleanupHnpSource(hnpDir: string): void {
	        // 保留 arm64-v8a/electron.hnp，删除 bin/、lib/ 和 hnp.json
	        const binDir = path.resolve(hnpDir, 'bin');
	        const libDir = path.resolve(hnpDir, 'lib');
	        const hnpJsonPath = path.resolve(hnpDir, 'hnp.json');

	        if (fs.existsSync(binDir)) {
	            this.rmdirRecursiveSync(binDir);
	        }
	        if (fs.existsSync(libDir)) {
	            this.rmdirRecursiveSync(libDir);
	        }
	        if (fs.existsSync(hnpJsonPath)) {
	            fs.unlinkSync(hnpJsonPath);
	        }
	    }

    private rmdirRecursiveSync(dirPath: string): void {
        if (fs.existsSync(dirPath)) {
            for (const entry of fs.readdirSync(dirPath)) {
                const fullPath = path.resolve(dirPath, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    this.rmdirRecursiveSync(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                }
            }
            fs.rmdirSync(dirPath);
        }
    }

    // ================================================================
    // 确保 module.json5 包含 hnpPackages 配置
    // ================================================================
    private ensureHnpConfigInModuleJson(moduleJsonPath: string): void {
        if (!fs.existsSync(moduleJsonPath)) {
            console.warn(`[${PLUGIN_ID}] module.json5 not found at ${moduleJsonPath}`);
            return;
        }

        const content = fs.readFileSync(moduleJsonPath, 'utf-8');

        // 检查是否已经包含 hnpPackages
        if (content.includes('hnpPackages')) {
            console.log(`[${PLUGIN_ID}] hnpPackages already configured in module.json5.`);
            return;
        }

        // 在 module 对象的最后一个字段前插入 hnpPackages
        // 简单策略：在 "abilities" 之前插入
        const hnpConfig = `    "hnpPackages": [
      {
        "package": "${HNP_NAME}.hnp",
        "type": "private"
      }
    ],`;

        let newContent: string;
        if (content.includes('"abilities"')) {
            newContent = content.replace(
                /(\s*)"abilities"/,
                `\n${hnpConfig}\n$1"abilities"`
            );
        } else {
            // fallback: 在 module 闭合前插入
            newContent = content.replace(
                /(\s*)\}$(\s*)$/m,
                `$1${hnpConfig}\n$1}$2`
            );
        }

        fs.writeFileSync(moduleJsonPath, newContent, 'utf-8');
        console.log(`[${PLUGIN_ID}] Added hnpPackages to module.json5.`);
    }

    // ================================================================
    // 运行时 Monkey-Patch: 在 PackingToolOptions.build 前注入 --hnp-path
    // ================================================================
    private patchPackingToolOptions(projectRoot: string): void {
        const hnpDir = path.resolve(projectRoot, 'hnp');
        if (!fs.existsSync(hnpDir)) {
            console.warn(`[${PLUGIN_ID}] hnp directory not found at ${hnpDir}, skipping patch.`);
            return;
        }

        try {
            // 寻找并加载 DevEco 的 PackingToolOptions 模块
            const packingToolPath = this.findPackingToolOptions();
            if (!packingToolPath) {
                console.warn(`[${PLUGIN_ID}] PackingToolOptions module not found, cannot inject --hnp-path.`);
                return;
            }

            const { PackingToolOptions } = require(packingToolPath);
            if (!PackingToolOptions) {
                console.warn(`[${PLUGIN_ID}] PackingToolOptions export not found.`);
                return;
            }

            // Monkey-patch build 方法
            const originalBuild = PackingToolOptions.prototype.build;
            if (!originalBuild) {
                console.warn(`[${PLUGIN_ID}] PackingToolOptions.build not found.`);
                return;
            }

            // 避免重复 patch
            if ((PackingToolOptions.prototype as any).__hnpPatched) {
                return;
            }

            PackingToolOptions.prototype.build = function () {
                // 在 build 前注入 --hnp-path
                const hnpDirResolved = path.resolve(process.cwd(), 'hnp');
                if (fs.existsSync(hnpDirResolved)) {
                    if (typeof this.addFieldAndPath === 'function') {
                        this.addFieldAndPath('--hnp-path', hnpDirResolved);
                    }
                }
                return originalBuild.call(this);
            };

            (PackingToolOptions.prototype as any).__hnpPatched = true;
            console.log(`[${PLUGIN_ID}] Successfully patched PackingToolOptions.build to inject --hnp-path.`);
        } catch (e) {
            console.error(`[${PLUGIN_ID}] Failed to patch PackingToolOptions:`, e);
        }
    }

    // ================================================================
    // 查找 DevEco 的 PackingToolOptions 模块
    // ================================================================
    private findPackingToolOptions(): string | null {
        const basePaths = [
            'D:\\DevEco Studio\\tools\\hvigor\\hvigor-ohos-plugin',
            'C:\\Program Files\\Huawei\\DevEco Studio\\tools\\hvigor\\hvigor-ohos-plugin',
        ];

        for (const base of basePaths) {
            const candidate = path.resolve(
                base,
                'src', 'builder', 'inner-java-command-builder', 'packing-tool-options.js'
            );
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        // 尝试从 hvigorw 的 node_modules 查找
        // hvigorw 在加载时会定位到 DevEco 的 hvigor 目录
        try {
            const hvigorOhosPluginPath = require.resolve('@ohos/hvigor-ohos-plugin');
            if (hvigorOhosPluginPath) {
                // @ohos/hvigor-ohos-plugin 的目录
                const pluginDir = path.dirname(hvigorOhosPluginPath);
                const candidate = path.resolve(
                    pluginDir,
                    'src', 'builder', 'inner-java-command-builder', 'packing-tool-options.js'
                );
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        } catch {
            // not found via require.resolve
        }

        return null;
    }
}
