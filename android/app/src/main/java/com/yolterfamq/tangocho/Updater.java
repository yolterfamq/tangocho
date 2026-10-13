package com.yolterfamq.tangocho;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Обновления через GitHub Releases: ищем Tangocho.apk в последнем релизе. */
public final class Updater {
    public static final String APK_NAME = "Tangocho.apk";

    public static final class Release {
        public String version, notes, url;
        public long size;
    }

    public interface Progress { void on(double p); }

    private Updater() {}

    public static String repo() { return BuildConfig.UPDATE_REPO == null ? "" : BuildConfig.UPDATE_REPO; }

    public static boolean enabled() { return repo().contains("/"); }

    public static String currentVersion(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "1.0.0";
        }
    }

    public static File apkFile(Context ctx) {
        File dir = new File(ctx.getCacheDir(), "update");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, APK_NAME);
    }

    private static File verFile(Context ctx) { return new File(apkFile(ctx).getPath() + ".ver"); }

    /** Сравнение версий 1.2.3 */
    public static int compare(String a, String b) {
        String[] x = a.replaceAll("^[vV]", "").split("\\."), y = b.replaceAll("^[vV]", "").split("\\.");
        for (int i = 0; i < 3; i++) {
            int p = i < x.length ? parse(x[i]) : 0, q = i < y.length ? parse(y[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int parse(String s) {
        try { return Integer.parseInt(s.replaceAll("\\D", "")); } catch (Exception e) { return 0; }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "Tangocho-Android");
        c.setRequestProperty("Accept", "application/vnd.github+json");
        return c;
    }

    /** Новый релиз или null, если у нас последняя версия. Вызывать не в UI-потоке. */
    public static Release check(Context ctx) throws Exception {
        HttpURLConnection c = open("https://api.github.com/repos/" + repo() + "/releases/latest");
        try {
            if (c.getResponseCode() != 200) throw new IOException("GitHub ответил " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[8192]; int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            JSONObject root = new JSONObject(buf.toString("UTF-8"));

            Release r = new Release();
            r.version = root.optString("tag_name", "").replaceAll("^[vV]", "");
            r.notes = root.optString("body", "");
            JSONArray assets = root.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject a = assets.getJSONObject(i);
                    if (APK_NAME.equalsIgnoreCase(a.optString("name"))) {
                        r.url = a.optString("browser_download_url");
                        r.size = a.optLong("size");
                    }
                }
            }
            if (r.url == null || r.version.isEmpty()) return null;
            return compare(r.version, currentVersion(ctx)) > 0 ? r : null;
        } finally {
            c.disconnect();
        }
    }

    /** Качает APK. Вызывать не в UI-потоке. */
    public static void download(Context ctx, Release r, Progress progress) throws Exception {
        File out = apkFile(ctx), part = new File(out.getPath() + ".part");
        HttpURLConnection c = open(r.url);
        c.setRequestProperty("Accept", "application/octet-stream");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("Сервер ответил " + code);
            long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : r.size;
            try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(part)) {
                byte[] b = new byte[65536]; int n; long read = 0; double last = -1;
                while ((n = in.read(b)) > 0) {
                    fo.write(b, 0, n);
                    read += n;
                    if (total > 0) {
                        double p = (double) read / total;
                        if (p - last >= 0.02) { last = p; progress.on(p); }
                    }
                }
                if (total > 0 && read != total) throw new IOException("Файл скачался не полностью");
            }
        } finally {
            c.disconnect();
        }
        //noinspection ResultOfMethodCallIgnored
        out.delete();
        if (!part.renameTo(out)) throw new IOException("Не удалось сохранить файл");
        try (FileOutputStream fo = new FileOutputStream(verFile(ctx))) {
            fo.write(r.version.getBytes("UTF-8"));
        }
        progress.on(1);
    }

    /** Версия уже скачанного обновления (если оно новее установленной) */
    public static String pendingVersion(Context ctx) {
        File apk = apkFile(ctx), ver = verFile(ctx);
        if (!apk.exists() || !ver.exists()) return null;
        try (InputStream in = new java.io.FileInputStream(ver)) {
            byte[] b = new byte[64]; int n = in.read(b);
            String v = new String(b, 0, Math.max(n, 0), "UTF-8").trim();
            if (compare(v, currentVersion(ctx)) > 0) return v;
        } catch (Exception ignored) { }
        //noinspection ResultOfMethodCallIgnored
        apk.delete();
        //noinspection ResultOfMethodCallIgnored
        ver.delete();
        return null;
    }

    public static boolean canInstall(Context ctx) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ctx.getPackageManager().canRequestPackageInstalls();
    }
}
