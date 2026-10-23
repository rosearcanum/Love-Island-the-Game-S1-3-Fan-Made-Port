package com.loveisland.player;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Love Island PC player, wrapped for Android.
 *
 * Everything is bundled in the app: the player (assets/player) and your converted seasons (assets/data),
 * which BUILD.bat copies in before building. (A "data" folder in Android/data/com.loveisland.player/files
 * still works too, as a fallback.) Saves are kept in the app's private storage.
 */
public class MainActivity extends Activity {

    private static final String HOST = "loveisland.local";
    private static final String START = "https://" + HOST + "/player/index.html";
    private static final Pattern SAFE = Pattern.compile("^[A-Za-z0-9_.-]{1,80}$");

    private WebView web;
    private File dataDir;
    private File saveDir;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        File ext = getExternalFilesDir(null);   // creates Android/data/<package>/files
        dataDir = new File(ext != null ? ext : getFilesDir(), "data");
        dataDir.mkdirs();
        saveDir = new File(getFilesDir(), "saves");
        saveDir.mkdirs();

        web = new WebView(this);
        web.setBackgroundColor(0xFF120B12);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // remembers settings like text speed
        s.setMediaPlaybackRequiresUserGesture(false);    // lets music start with the story
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.addJavascriptInterface(new Bridge(), "LIBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serve(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !HOST.equals(req.getUrl().getHost());   // never leave the game
            }
        });

        // Phone Back button opens the game menu (Android 13+ uses this; older phones use onBackPressed)
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::sendBack);
        }

        hideSystemBars();
        if (savedInstanceState == null) web.loadUrl(START);
        else web.restoreState(savedInstanceState);
    }

    /* ------------------------------------------------------------ local files */

    private WebResourceResponse serve(Uri u) {
        if (!HOST.equals(u.getHost())) return notFound();      // the app has no internet access anyway
        String path = u.getPath() == null ? "/" : u.getPath();
        try {
            if (path.startsWith("/player/")) {
                String name = path.substring("/player/".length());
                if (name.isEmpty()) name = "index.html";
                if (name.contains("..")) return notFound();
                return ok(name, getAssets().open("player/" + name));
            }
            if (path.startsWith("/data/")) {
                String rel = path.substring("/data/".length());
                if (rel.contains("..")) return notFound();
                try {
                    return ok(rel, getAssets().open("data/" + rel));      // seasons packed inside the app
                } catch (IOException notPacked) {
                    // fall through to the folder on the phone
                }
                File f = new File(dataDir, rel);
                String root = dataDir.getCanonicalPath() + File.separator;
                if (!f.getCanonicalPath().startsWith(root) || !f.isFile()) return notFound();
                return ok(f.getName(), new FileInputStream(f));
            }
        } catch (IOException e) {
            return notFound();
        }
        return notFound();
    }

    private static WebResourceResponse ok(String name, InputStream in) {
        String mime = mimeOf(name);
        boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.endsWith("+xml");
        WebResourceResponse r = new WebResourceResponse(mime, text ? "utf-8" : null, in);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        r.setResponseHeaders(h);
        return r;
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8",
                new ByteArrayInputStream(new byte[0]));
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".ogg")) return "audio/ogg";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    /* ------------------------------------------------------------ bridge used by ui.js */

    private File saveFile(String season, String name) {
        if (season == null || name == null || !SAFE.matcher(season).matches() || !SAFE.matcher(name).matches())
            return null;
        File dir = new File(saveDir, season);
        dir.mkdirs();
        return new File(dir, name + ".json");
    }

    private class Bridge {
        @JavascriptInterface
        public String seasons() {
            JSONArray out = new JSONArray();
            java.util.TreeSet<String> ids = new java.util.TreeSet<>();
            try {
                String[] packed = getAssets().list("data");
                if (packed != null) for (String id : packed) {
                    try (InputStream in = getAssets().open("data/" + id + "/episodes.json")) {
                        ids.add(id);
                    } catch (IOException ignored) {
                    }
                }
            } catch (IOException ignored) {
            }
            File[] dirs = dataDir.listFiles();
            if (dirs != null) for (File d : dirs) if (new File(d, "episodes.json").isFile()) ids.add(d.getName());
            for (String id : ids) {
                try {
                    out.put(new JSONObject().put("id", id));
                } catch (Exception ignored) {
                }
            }
            if (ids.size() > 0) return out.toString();
            dirs = dataDir.listFiles();
            if (dirs != null) {
                Arrays.sort(dirs);
                for (File d : dirs) {
                    if (new File(d, "episodes.json").isFile()) {
                        try {
                            out.put(new JSONObject().put("id", d.getName()));
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
            return out.toString();
        }

        @JavascriptInterface
        public String load(String season, String name) {
            File f = saveFile(season, name);
            if (f == null || !f.isFile()) return "null";
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[(int) f.length()];
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
                return new String(buf, 0, off, StandardCharsets.UTF_8);
            } catch (IOException e) {
                return "null";
            }
        }

        @JavascriptInterface
        public boolean save(String season, String name, String json) {
            File f = saveFile(season, name);
            if (f == null || json == null) return false;
            File tmp = new File(f.getPath() + ".tmp");
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                return false;
            }
            return tmp.renameTo(f) || (f.delete() && tmp.renameTo(f));
        }

        @JavascriptInterface
        public String dataPath() {
            return dataDir.getAbsolutePath();
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finish);
        }
    }

    /* ------------------------------------------------------------ app lifecycle */

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        sendBack();
    }

    private void sendBack() {
        web.evaluateJavascript("window.__liBack && window.__liBack()", null);   // opens the game menu
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.__liSaveNow && window.__liSaveNow()", null);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }
}
