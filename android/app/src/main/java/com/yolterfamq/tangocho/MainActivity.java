package com.yolterfamq.tangocho;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String HOST = "tangocho.app";
    private static final String START = "https://" + HOST + "/index.html";

    private WebView web;
    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private Updater.Release release;
    private boolean busy, webReady, waitingForPermission;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("tangocho", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0C0E12"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage — тут хранится прогресс
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);

        web.addJavascriptInterface(new Bridge(), "TangochoAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath() == null || u.getPath().equals("/") ? "index.html" : u.getPath().substring(1);
                try {
                    InputStream in = getAssets().open(path);
                    String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "text/javascript"
                            : path.endsWith(".css") ? "text/css" : "application/octet-stream";
                    return new WebResourceResponse(mime, "UTF-8", in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openUrl(u.toString());
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(START);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Вернулись из настроек «Установка неизвестных приложений»
        if (waitingForPermission) {
            waitingForPermission = false;
            if (Updater.canInstall(this)) install();
            else sendStatus("error", "Без разрешения на установку обновление не поставить. Нажми «Установить» ещё раз.");
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__hostBack ? window.__hostBack() : false", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    // ───────── Мост страница ↔ приложение ─────────

    private class Bridge {
        @JavascriptInterface
        public void postMessage(String json) {
            ui.post(() -> onMessage(json));
        }
    }

    private void send(JSONObject msg) {
        if (!webReady) return;
        web.evaluateJavascript("window.__host && window.__host(" + msg + ")", null);
    }

    private void sendStatus(String state, String message) { sendStatus(state, message, null); }

    private void sendStatus(String state, String message, Double progress) {
        try {
            JSONObject m = new JSONObject();
            m.put("type", "status");
            m.put("state", state);
            if (message != null) m.put("message", message);
            if (progress != null) m.put("progress", progress);
            String v = release != null ? release.version : Updater.pendingVersion(this);
            if (v != null) m.put("version", v);
            if (release != null) m.put("notes", release.notes);
            send(m);
        } catch (Exception ignored) { }
    }

    private void onMessage(String json) {
        JSONObject m;
        try { m = new JSONObject(json); } catch (Exception e) { return; }
        switch (m.optString("type")) {
            case "ready": {
                webReady = true;
                String cur = Updater.currentVersion(this);
                String last = prefs.getString("lastVersion", "");
                boolean justUpdated = !last.isEmpty() && !last.equals(cur);
                prefs.edit().putString("lastVersion", cur).apply();
                try {
                    JSONObject info = new JSONObject();
                    info.put("type", "info");
                    info.put("platform", "android");
                    info.put("version", cur);
                    info.put("enabled", Updater.enabled());
                    info.put("repo", Updater.repo());
                    info.put("auto", prefs.getBoolean("auto", true));
                    info.put("justUpdated", justUpdated);
                    send(info);
                } catch (Exception ignored) { }
                if (Updater.pendingVersion(this) != null) sendStatus("ready", null);
                else if (Updater.enabled() && prefs.getBoolean("auto", true)) check(true, true);
                else sendStatus("idle", null);
                break;
            }
            case "check": check(false, false); break;
            case "download": download(); break;
            case "install": install(); break;
            case "auto": prefs.edit().putBoolean("auto", m.optBoolean("value", true)).apply(); break;
            case "theme": setBars(m.optBoolean("dark", true)); break;
            case "open": openUrl(m.optString("url")); break;
        }
    }

    // ───────── Обновления ─────────

    private void check(boolean autoDownload, boolean silent) {
        if (busy) return;
        if (!Updater.enabled()) { sendStatus("disabled", null); return; }
        if (Updater.pendingVersion(this) != null) { sendStatus("ready", null); return; }
        busy = true;
        if (!silent) sendStatus("checking", null);
        io.execute(() -> {
            try {
                Updater.Release r = Updater.check(this);
                ui.post(() -> {
                    busy = false;
                    release = r;
                    if (r == null) { sendStatus("latest", null); return; }
                    sendStatus("available", null);
                    if (autoDownload) download();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    busy = false;
                    if (silent) sendStatus("idle", null);
                    else sendStatus("error", "Не удалось проверить обновления. Проверь интернет. (" + e.getMessage() + ")");
                });
            }
        });
    }

    private void download() {
        if (busy || release == null) return;
        busy = true;
        final Updater.Release r = release;
        sendStatus("downloading", null, 0.0);
        io.execute(() -> {
            try {
                Updater.download(this, r, p -> ui.post(() -> sendStatus("downloading", null, p)));
                ui.post(() -> { busy = false; sendStatus("ready", null); });
            } catch (Exception e) {
                ui.post(() -> { busy = false; sendStatus("error", "Не удалось скачать обновление: " + e.getMessage()); });
            }
        });
    }

    private void install() {
        if (Updater.pendingVersion(this) == null) { sendStatus("error", "Файл обновления не найден. Проверь обновления ещё раз."); return; }
        if (!Updater.canInstall(this)) {
            // Один раз нужно разрешить Тангочо ставить обновления
            waitingForPermission = true;
            sendStatus("permission", "Разреши «Установку неизвестных приложений» для Тангочо и вернись назад.");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                waitingForPermission = false;
                sendStatus("error", "Открой настройки и разреши Тангочо устанавливать приложения.");
            }
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(ApkProvider.uri(), "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            sendStatus("error", "На телефоне не нашёлся установщик приложений.");
        }
    }

    // ───────── Разное ─────────

    private void openUrl(String url) {
        if (url == null || !url.startsWith("https://")) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    /** Цвет статус-бара и навигации под тему страницы */
    @SuppressWarnings("deprecation")
    private void setBars(boolean dark) {
        int bg = Color.parseColor(dark ? "#0C0E12" : "#F2F3F6");
        Window w = getWindow();
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        web.setBackgroundColor(bg);
        View d = w.getDecorView();
        int flags = d.getSystemUiVisibility();
        if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        d.setSystemUiVisibility(flags);
    }
}
