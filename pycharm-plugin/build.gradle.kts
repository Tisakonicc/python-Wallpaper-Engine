plugins {
    id("java")
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.tisako"
version = "0.8.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    // 直接使用本机安装的 PyCharm 作为 SDK，省去下载一整套 IDE
    intellijPlatform {
        local("D:/PyCharm 2024.1.7")
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

// 源码里有中文注释，必须显式声明 UTF-8，否则 Windows 默认 GBK 会报“不可映射字符”
tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

// 没有用到 @NotNull 运行时断言/表单，跳过字节码插桩，省掉 Java Compiler 依赖
tasks.matching { it.name == "instrumentCode" }.configureEach { enabled = false }

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        name = "Background Wallpaper Engine"
        version = project.version.toString()
        description = """
            Background Wallpaper Engine renders a still frame from Wallpaper Engine as a full-window background behind the entire IDE — project tree, toolbars, editor and status bar all show through, while code stays readable.

            整窗壁纸：把 Wallpaper Engine 的壁纸铺到整个 IDE 窗口，项目树、工具栏、编辑器、状态栏都能透出背景。
            基于平台自带的背景图机制渲染，不修改任何组件的透明度或背景色；禁用插件时界面完全恢复原状。
            右侧「壁纸」面板可实时调节不透明度、虚化、代码区压暗、水平位置与填充方式。
            兼容性：与 Material Theme UI（完整版）冲突，请勿同时启用。
            限制：仅支持静态画面，视频 / 场景 / 网页类壁纸取其预览帧。
        """.trimIndent()
        vendor {
            name = "Tisako"
        }
        ideaVersion {
            sinceBuild = "241"
            untilBuild = "241.*"
        }
    }
}
