plugins {
    id("java")
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.tisako"
version = "0.7.6"

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
        name = "Background-Wallpaper-Engine"
        version = project.version.toString()
        description = """
            把 Steam Wallpaper Engine 的壁纸（视频 / 图片）渲染成编辑器背景。<br/>
            壁纸由本地 127.0.0.1 上的小型 HTTP 服务提供，嵌入 JCEF 浏览器显示，不修改 IDE 安装文件。
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
