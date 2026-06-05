package com.fastviewer.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        FastViewerFilesPlugin.setLatestIntent(getIntent());
        registerPlugin(FastViewerFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        FastViewerFilesPlugin.handleNewIntent(intent);
    }
}
