package com.tisako.wallpaper;

import com.intellij.openapi.options.SearchableConfigurable;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.components.JBLabel;
import com.intellij.util.ui.FormBuilder;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.Nls;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JPanel;
import javax.swing.JSpinner;
import javax.swing.SpinnerNumberModel;
import java.awt.FlowLayout;
import java.util.ArrayList;
import java.util.List;

/** 设置页：Tools → 壁纸背景。 */
public final class WallpaperConfigurable implements SearchableConfigurable {

    private final WallpaperService service = WallpaperService.getInstance();
    private final List<String> imports = new ArrayList<>();

    private JCheckBox enabled;
    private JComboBox<WallpaperEntry> wallpaper;
    private JSpinner opacity;
    private JBLabel status;
    private JPanel panel;

    @Override
    public @NotNull String getId() {
        return "com.tisako.wallpaper.settings";
    }

    @Override
    public @Nls String getDisplayName() {
        return "壁纸背景";
    }

    @Override
    public @Nullable JComponent createComponent() {
        imports.clear();
        if (service.settings().imports != null) imports.addAll(service.settings().imports);
        service.rescan();

        enabled = new JCheckBox("启用编辑器背景壁纸", service.settings().enabled);
        wallpaper = new JComboBox<>(service.entries().toArray(new WallpaperEntry[0]));
        wallpaper.setPrototypeDisplayValue(new WallpaperEntry("", "占位占位占位占位占位", "video", null, null, false));
        selectCurrent();

        opacity = new JSpinner(new SpinnerNumberModel(service.settings().opacity, 10, 100, 5));

        JButton importButton = new JButton("导入本地视频 / 图片…");
        importButton.addActionListener(event -> chooseFiles());
        JButton rescanButton = new JButton("重新扫描");
        rescanButton.addActionListener(event -> {
            service.rescan();
            refillWallpaperCombo();
            updateStatus();
        });

        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(8), 0));
        buttons.setOpaque(false);
        buttons.add(importButton);
        buttons.add(rescanButton);

        status = new JBLabel();
        updateStatus();

        panel = FormBuilder.createFormBuilder()
                .addComponent(enabled)
                .addLabeledComponent("壁纸", wallpaper, 1, false)
                .addLabeledComponent("不透明度", opacity, 1, false)
                .addComponent(buttons)
                .addComponent(status)
                .addComponentFillVertically(new JPanel(), 0)
                .getPanel();
        panel.setBorder(JBUI.Borders.empty(8));
        return panel;
    }

    private void chooseFiles() {
        FileChooserDescriptor descriptor = new FileChooserDescriptor(true, false, false, false, false, true)
                .withTitle("选择视频或图片")
                .withFileFilter(file -> {
                    String name = file.getName().toLowerCase();
                    return name.endsWith(".mp4") || name.endsWith(".webm") || name.endsWith(".mov")
                            || name.endsWith(".m4v") || name.endsWith(".gif") || name.endsWith(".png")
                            || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp")
                            || name.endsWith(".bmp") || name.endsWith(".avif");
                });
        VirtualFile[] files = FileChooser.chooseFiles(descriptor, null, null);
        if (files.length == 0) return;
        for (VirtualFile file : files) {
            String path = file.getPath();
            if (!imports.contains(path)) imports.add(path);
        }
        service.settings().imports = new ArrayList<>(imports);
        service.rescan();
        refillWallpaperCombo();

        // 选中刚导入的最后一个，省得再翻列表
        String last = files[files.length - 1].getPath();
        for (WallpaperEntry entry : service.entries()) {
            if (entry.imported && entry.media != null && entry.media.toString().equals(last)) {
                wallpaper.setSelectedItem(entry);
                break;
            }
        }
        updateStatus();
    }

    private void refillWallpaperCombo() {
        wallpaper.removeAllItems();
        for (WallpaperEntry entry : service.entries()) wallpaper.addItem(entry);
        selectCurrent();
    }

    private void selectCurrent() {
        String id = service.settings().wallpaperId;
        for (int i = 0; i < wallpaper.getItemCount(); i++) {
            if (wallpaper.getItemAt(i).id.equals(id)) {
                wallpaper.setSelectedIndex(i);
                return;
            }
        }
    }

    private void updateStatus() {
        int count = service.entries().size();
        status.setText(count == 0
                ? "没有找到壁纸：请确认 Steam 已安装 Wallpaper Engine 并订阅了壁纸，或点上面的导入按钮。"
                : "共 " + count + " 个壁纸（含导入 " + imports.size() + " 个）。场景 / 网页壁纸当前显示缩略图。");
    }

    @Override
    public boolean isModified() {
        WallpaperService.Settings current = service.settings();
        return enabled.isSelected() != current.enabled
                || opacity.getValue().equals(current.opacity) == false
                || (wallpaper.getSelectedItem() instanceof WallpaperEntry entry && !entry.id.equals(current.wallpaperId))
                || !imports.equals(current.imports == null ? List.of() : current.imports);
    }

    @Override
    public void apply() {
        WallpaperService.Settings current = service.settings();
        current.enabled = enabled.isSelected();
        current.opacity = (Integer) opacity.getValue();
        if (wallpaper.getSelectedItem() instanceof WallpaperEntry entry) current.wallpaperId = entry.id;
        current.imports = new ArrayList<>(imports);
        service.reload();
    }

    @Override
    public void reset() {
        imports.clear();
        if (service.settings().imports != null) imports.addAll(service.settings().imports);
        enabled.setSelected(service.settings().enabled);
        opacity.setValue(service.settings().opacity);        refillWallpaperCombo();
        updateStatus();
    }

    @Override
    public void disposeUIResources() {
        panel = null;
    }
}
