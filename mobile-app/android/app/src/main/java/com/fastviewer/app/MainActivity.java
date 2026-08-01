package com.fastviewer.app;

import android.content.Intent;
import android.os.Bundle;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int MENU_HIGHLIGHT = 0x4c5001;
    private static final int MENU_NOTE = 0x4c5002;
    private static final int MENU_CARD = 0x4c5003;
    @Override
    public void onCreate(Bundle savedInstanceState) {
        FastViewerFilesPlugin.setInitialIntent(getIntent());
        registerPlugin(FastViewerFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        FastViewerFilesPlugin.handleNewIntent(intent);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (FastViewerFilesPlugin.handleVolumeKey(event.getKeyCode(), event.getAction())) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        super.onActionModeStarted(mode);
        if (!FastViewerFilesPlugin.areSelectionActionsEnabled()) return;
        addSelectionAction(mode, MENU_HIGHLIGHT, "高亮", "highlight");
        addSelectionAction(mode, MENU_NOTE, "批注", "note");
        addSelectionAction(mode, MENU_CARD, "卡片", "card");
        mode.invalidate();
    }

    private void addSelectionAction(ActionMode mode, int itemId, String title, String action) {
        Menu menu = mode.getMenu();
        if (menu.findItem(itemId) != null) return;
        MenuItem item = menu.add(Menu.NONE, itemId, Menu.FIRST, title);
        item.setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS);
        item.setOnMenuItemClickListener(clicked -> {
            emitSelectionAction(action);
            return true;
        });
    }

    private void emitSelectionAction(String action) {
        if (bridge == null || bridge.getWebView() == null) return;
        String script = "window.dispatchEvent(new CustomEvent('lightpage:native-selection-action',{detail:{action:'"
            + action + "'}}));";
        bridge.getWebView().evaluateJavascript(script, null);
    }

}
