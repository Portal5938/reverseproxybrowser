export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Handle OPTIONS Preflight Requests (Crucial for GitHub APIs & Cross-Origin Fetch)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // Read active proxy target cookie
    const cookies = request.headers.get("Cookie") || "";
    let activeTargetCookie = cookies.match(/__proxy_target=([^;]+)/)?.[1];
    if (activeTargetCookie) {
      try { activeTargetCookie = decodeURIComponent(activeTargetCookie); } catch(e){}
    }

    // 1. SERVE BROWSER CONTAINER UI (Served at root)
    if (url.pathname === "/" && !url.searchParams.get("url") && !request.headers.get("Referer")?.includes("/render/")) {
      return new Response(getBrowserAppHTML(), {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    // 2. EXTRACT TARGET URL
    let rawTarget = "";
    let isDirectNavigation = false;

    if (url.pathname.startsWith("/render/")) {
      rawTarget = request.url.substring(request.url.indexOf("/render/") + 8);
      isDirectNavigation = true;
    } else if (url.searchParams.has("url")) {
      rawTarget = url.searchParams.get("url");
      isDirectNavigation = true;
    } else {
      const referer = request.headers.get("Referer");
      if (referer && referer.includes("/render/")) {
        const refererTarget = referer.substring(referer.indexOf("/render/") + 8);
        try {
          const baseTargetUrl = new URL(refererTarget.replace(/^(https?:\/)([^\/])/, "$1/$2"));
          rawTarget = new URL(url.pathname + url.search, baseTargetUrl.href).href;
        } catch (e) {}
      } else if (activeTargetCookie) {
        try {
          rawTarget = new URL(url.pathname + url.search, activeTargetCookie).href;
        } catch (e) {}
      }
    }

    if (!rawTarget) {
      return new Response(getBrowserAppHTML(), {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    // Restore double slashes in protocol if collapsed
    rawTarget = rawTarget.replace(/^(https?:\/)([^\/])/, "$1/$2");

    try {
      const targetUrl = new URL(rawTarget);

      // Header Sanitization & Forwarding
      const proxyHeaders = new Headers();

      for (const [key, value] of request.headers.entries()) {
        const lKey = key.toLowerCase();
        if (
          lKey.startsWith("x-") ||
          lKey.startsWith("sec-fetch-") ||
          [
            "accept", "accept-language", "user-agent", "range", 
            "content-type", "if-none-match", "if-modified-since", 
            "cookie", "authorization", "cache-control"
          ].includes(lKey)
        ) {
          proxyHeaders.set(key, value);
        }
      }

      proxyHeaders.set("Host", targetUrl.host);
      proxyHeaders.set("Origin", targetUrl.origin);
      proxyHeaders.set("Referer", targetUrl.href);

      const fetchOptions = {
        method: request.method,
        headers: proxyHeaders,
        body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
        redirect: "manual"
      };

      const gatewayResponse = await fetch(targetUrl.href, fetchOptions);
      const outputHeaders = new Headers(gatewayResponse.headers);

      // Strip security restrictions
      outputHeaders.delete("X-Frame-Options");
      outputHeaders.delete("Content-Security-Policy");
      outputHeaders.delete("Frame-Options");
      outputHeaders.delete("Cross-Origin-Opener-Policy");
      outputHeaders.delete("Cross-Origin-Embedder-Policy");
      outputHeaders.set("Access-Control-Allow-Origin", "*");
      outputHeaders.set("Access-Control-Allow-Credentials", "true");
      outputHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
      outputHeaders.set("Access-Control-Allow-Headers", "*");

      const contentType = gatewayResponse.headers.get("Content-Type") || "";
      const isHtmlDoc = contentType.includes("text/html");

      // Session tracking
      if (isDirectNavigation && isHtmlDoc && !targetUrl.hostname.includes("id5") && !targetUrl.hostname.includes("ad")) {
        outputHeaders.append("Set-Cookie", `__proxy_target=${encodeURIComponent(targetUrl.href)}; Path=/; SameSite=Lax`);
      }

      // Handle Redirects
      if ([301, 302, 303, 307, 308].includes(gatewayResponse.status)) {
        const locationHeader = gatewayResponse.headers.get("Location");
        if (locationHeader) {
          const absoluteRedirectUrl = new URL(locationHeader, targetUrl.href).href;
          outputHeaders.set("Location", `${url.origin}/render/${absoluteRedirectUrl}`);
        }
        return new Response(null, { status: gatewayResponse.status, headers: outputHeaders });
      }

      // CSS REWRITING
      if (contentType.includes("text/css") || targetUrl.pathname.endsWith(".css")) {
        let css = await gatewayResponse.text();
        const proxyPrefix = `${url.origin}/render/`;
        const cssBaseDir = targetUrl.href.substring(0, targetUrl.href.lastIndexOf("/") + 1);

        css = css.replace(/url\((['"]?)([^'"\)]+)\1\)/g, (match, quote, path) => {
          if (path.startsWith("data:") || path.startsWith("blob:") || path.startsWith("http://") || path.startsWith("https://") || path.startsWith(proxyPrefix)) {
            return match;
          }
          const abs = path.startsWith("/") ? targetUrl.origin + path : cssBaseDir + path;
          return `url(${quote}${proxyPrefix}${abs}${quote})`;
        });

        outputHeaders.set("Content-Type", "text/css; charset=UTF-8");
        return new Response(css, { status: gatewayResponse.status, headers: outputHeaders });
      }

      // HTML DOCUMENT INTERCEPTION
      if (isHtmlDoc || targetUrl.pathname.endsWith(".html") || targetUrl.pathname.endsWith(".htm")) {
        outputHeaders.set("Content-Type", "text/html; charset=UTF-8");

        let html = await gatewayResponse.text();
        const proxyBaseHref = `${url.origin}/render/${targetUrl.href}`;
        const runtimeHook = getRuntimeScript(url.origin, targetUrl.href, targetUrl.origin);

        if (html.includes("<head>")) {
          html = html.replace("<head>", `<head><base href="${proxyBaseHref}">${runtimeHook}`);
        } else {
          html = `<base href="${proxyBaseHref}">${runtimeHook}` + html;
        }

        return new Response(html, { status: gatewayResponse.status, headers: outputHeaders });
      }

      // Binary Assets, Scripts, Fonts, and Media
      if (targetUrl.pathname.endsWith(".wasm")) outputHeaders.set("Content-Type", "application/wasm");
      else if (targetUrl.pathname.endsWith(".js")) outputHeaders.set("Content-Type", "application/javascript");
      else if (targetUrl.pathname.endsWith(".epk")) outputHeaders.set("Content-Type", "application/octet-stream");

      return new Response(gatewayResponse.body, { status: gatewayResponse.status, headers: outputHeaders });

    } catch (err) {
      return new Response(`Proxy Runtime Error: ${err.message}`, { status: 500 });
    }
  }
};

// ---------------------------------------------------------------------------
// 1. BROWSER UI LAYOUT (Tabs, Bookmarks, File Import, Confirmation)
// ---------------------------------------------------------------------------
function getBrowserAppHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Browser</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { width: 100%; height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1e1e1e; color: #fff; }
        
        #browser-container { display: flex; flex-direction: column; width: 100vw; height: 100vh; }
        
        /* Tab Bar Styles */
        #tab-bar { display: flex; align-items: center; background: #1c1b22; height: 36px; padding: 0 8px; gap: 4px; overflow-x: auto; border-bottom: 1px solid #2b2a33; }
        .tab { display: flex; align-items: center; gap: 8px; background: #2b2a33; color: #b1b1b3; padding: 6px 12px; border-radius: 8px 8px 0 0; font-size: 12px; cursor: pointer; max-width: 180px; min-width: 100px; height: 30px; margin-top: 6px; user-select: none; transition: background 0.15s, color 0.15s; }
        .tab:hover { background: #38383d; color: #fff; }
        .tab.active { background: #2b2a33; color: #00dd80; border-top: 2px solid #00dd80; font-weight: bold; }
        .tab-title { flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tab-close { background: transparent; border: none; color: #888; font-size: 12px; border-radius: 50%; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .tab-close:hover { background: rgba(255,255,255,0.2); color: #fff; }
        #add-tab-btn { background: transparent; border: none; color: #b1b1b3; font-size: 18px; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        #add-tab-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }

        /* Top Navigation Toolbar */
        #toolbar { display: flex; align-items: center; gap: 8px; background: #2b2a33; padding: 6px 12px; border-bottom: 1px solid #38383d; height: 44px; }
        .nav-btn { background: transparent; border: none; color: #fbfbfe; width: 30px; height: 30px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 15px; transition: background 0.15s; }
        .nav-btn:hover { background: rgba(255, 255, 255, 0.1); }
        .nav-btn:active { background: rgba(255, 255, 255, 0.2); }
        .action-btn { background: #38383d; color: #fff; border: 1px solid #4a4a4f; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 6px; height: 28px; transition: background 0.15s; }
        .action-btn:hover { background: #4a4a4f; color: #00dd80; }
        
        #address-bar-container { flex-grow: 1; display: flex; align-items: center; background: #1c1b22; border: 1px solid #4a4a4f; border-radius: 20px; padding: 0 12px; height: 28px; transition: border-color 0.15s; }
        #address-bar-container:focus-within { border-color: #00dd80; }
        #address-bar { width: 100%; background: transparent; border: none; outline: none; color: #fbfbfe; font-size: 13px; }
        #star-btn { background: transparent; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 0 4px; }
        #star-btn.bookmarked { color: #ffcc00; }
        
        #go-btn { background: #00dd80; color: #1c1b22; border: none; padding: 4px 12px; border-radius: 14px; font-weight: bold; font-size: 12px; cursor: pointer; height: 24px; }
        #go-btn:hover { background: #00b368; }

        /* Bookmarks Bar */
        #bookmarks-bar { display: flex; align-items: center; gap: 6px; background: #25242c; padding: 4px 12px; border-bottom: 1px solid #38383d; height: 28px; overflow-x: auto; font-size: 11px; }
        .bookmark-chip { display: flex; align-items: center; gap: 6px; background: #2b2a33; border: 1px solid #38383d; color: #ccc; padding: 2px 8px; border-radius: 12px; cursor: pointer; white-space: nowrap; max-width: 150px; }
        .bookmark-chip:hover { color: #00dd80; border-color: #00dd80; }
        .bookmark-chip .bm-title { overflow: hidden; text-overflow: ellipsis; }
        .bookmark-chip .bm-del { color: #888; font-size: 10px; border-radius: 50%; }
        .bookmark-chip .bm-del:hover { color: #ff5555; }

        /* Main Viewport Container */
        #viewport-container { width: 100%; flex-grow: 1; position: relative; background: #ffffff; }
        .viewport-frame { width: 100%; height: 100%; border: none; position: absolute; top: 0; left: 0; }

        :fullscreen #tab-bar, :fullscreen #toolbar, :fullscreen #bookmarks-bar,
        :-webkit-full-screen #tab-bar, :-webkit-full-screen #toolbar, :-webkit-full-screen #bookmarks-bar { display: none !important; }
        :fullscreen #viewport-container, :-webkit-full-screen #viewport-container { height: 100vh !important; width: 100vw !important; }

        /* Landing View */
        #landing-view { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #1e1e1e; display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 10; }
        .welcome-card { background: #2b2a33; padding: 32px; border-radius: 16px; border: 1px solid #38383d; text-align: center; max-width: 500px; width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .welcome-card h2 { color: #00dd80; margin-bottom: 12px; font-size: 22px; }
        .welcome-card p { color: #b1b1b3; font-size: 13px; margin-bottom: 20px; line-height: 1.5; }
        .landing-input { display: flex; gap: 8px; margin-bottom: 16px; }
        .landing-input input { flex-grow: 1; background: #1c1b22; border: 1px solid #4a4a4f; color: white; padding: 10px 14px; border-radius: 8px; outline: none; font-size: 14px; }
        .landing-input button { background: #00dd80; color: #1c1b22; border: none; padding: 10px 18px; border-radius: 8px; font-weight: bold; cursor: pointer; }
        .import-landing-btn { background: #38383d; color: #fff; border: 1px solid #4a4a4f; padding: 10px 18px; border-radius: 8px; font-weight: bold; cursor: pointer; width: 100%; font-size: 13px; transition: background 0.15s; }
        .import-landing-btn:hover { background: #4a4a4f; color: #00dd80; }
    </style>
</head>
<body>
    <div id="browser-container">
        <!-- Tab Bar -->
        <div id="tab-bar">
            <div id="tabs-list" style="display:flex; gap:4px;"></div>
            <button id="add-tab-btn" onclick="createNewTab()" title="New Tab">+</button>
        </div>

        <!-- Top Toolbar -->
        <div id="toolbar">
            <button class="nav-btn" onclick="goBack()" title="Back">&#129144;</button>
            <button class="nav-btn" onclick="goForward()" title="Forward">&#129146;</button>
            <button class="nav-btn" onclick="reloadPage()" title="Reload">&#8635;</button>
            <button class="nav-btn" onclick="confirmAndExecute(goHome)" title="Home">&#8962;</button>
            
            <div id="address-bar-container">
                <input type="text" id="address-bar" placeholder="Search or enter web address..." onkeypress="handleKeyPress(event)" />
                <button id="star-btn" onclick="toggleBookmark()" title="Bookmark this page">&#9733;</button>
            </div>
            
            <button id="go-btn" onclick="confirmAndExecute(navigateFromAddressBar)">Go</button>
            
            <button class="action-btn" onclick="triggerFileImport()" title="Import & Run TXT/HTM File">
                &#128194; Import
            </button>
            <!-- Hidden File Input -->
            <input type="file" id="file-importer" accept=".htm,.html,.txt" style="display:none" onchange="handleFileSelected(event)" />
        </div>

        <!-- Bookmarks Bar -->
        <div id="bookmarks-bar">
            <span style="color:#666; font-size:11px; margin-right:4px;">Bookmarks:</span>
            <div id="bookmarks-list" style="display:flex; gap:6px;"></div>
        </div>

        <!-- Viewport Container -->
        <div id="viewport-container">
            <!-- Landing Screen Overlay -->
            <div id="landing-view">
                <div class="welcome-card">
                    <h2>Cloud Web Browser</h2>
                    <p>Enter a URL to browse or import an offline .htm / .txt file to execute in an about:blank environment.</p>
                    <div class="landing-input">
                        <input type="text" id="landing-url-input" placeholder="e.g. eaglercraft.com" onkeypress="if(event.key==='Enter') launchFromLanding()" />
                        <button onclick="launchFromLanding()">Launch</button>
                    </div>
                    <button class="import-landing-btn" onclick="triggerFileImport()">
                        &#128194; Browse Local File (.htm / .txt)
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        // State Management
        let tabs = [];
        let activeTabId = null;
        let bookmarks = JSON.parse(localStorage.getItem("proxy_bookmarks") || "[]");

        const viewportContainer = document.getElementById("viewport-container");
        const addressBar = document.getElementById("address-bar");
        const landingView = document.getElementById("landing-view");
        const toolbar = document.getElementById("toolbar");
        const tabListEl = document.getElementById("tabs-list");
        const bookmarksListEl = document.getElementById("bookmarks-list");
        const starBtn = document.getElementById("star-btn");

        // Browser Exit Protection
        window.addEventListener("beforeunload", function (e) {
            e.preventDefault();
            e.returnValue = "Are you sure you want to leave?";
            return "Are you sure you want to leave?";
        });

        function showConfirmModal(message, onConfirm) {
            const existing = document.getElementById('proxy-confirm-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'proxy-confirm-overlay';
            overlay.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.75); z-index:99999999; display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

            const modal = document.createElement('div');
            modal.style.cssText = 'background:#2b2a33; border:2px solid #00dd80; border-radius:12px; padding:24px; text-align:center; max-width:380px; width:90%; color:#fff; box-shadow:0 10px 30px rgba(0,0,0,0.8);';

            const title = document.createElement('h3');
            title.innerText = 'Confirmation Needed';
            title.style.cssText = 'margin:0 0 10px 0; color:#00dd80; font-size:18px;';

            const desc = document.createElement('p');
            desc.innerText = message || 'Are you sure you want to leave or change this page?';
            desc.style.cssText = 'font-size:13px; color:#ccc; margin-bottom:20px; line-height:1.4;';

            const btnContainer = document.createElement('div');
            btnContainer.style.cssText = 'display:flex; gap:12px; justify-content:center;';

            const cancelBtn = document.createElement('button');
            cancelBtn.innerText = 'Cancel';
            cancelBtn.style.cssText = 'background:#4a4a4f; color:#fff; border:none; padding:10px 18px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:13px; flex:1;';

            const confirmBtn = document.createElement('button');
            confirmBtn.innerText = 'Confirm';
            confirmBtn.style.cssText = 'background:#00dd80; color:#121212; border:none; padding:10px 18px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:13px; flex:1;';

            btnContainer.appendChild(cancelBtn);
            btnContainer.appendChild(confirmBtn);
            modal.appendChild(title);
            modal.appendChild(desc);
            modal.appendChild(btnContainer);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            cancelBtn.onclick = () => overlay.remove();
            confirmBtn.onclick = () => {
                overlay.remove();
                if (onConfirm) onConfirm();
            };
        }

        function confirmAndExecute(actionFn) {
            const activeTab = getActiveTab();
            if (!activeTab || activeTab.isLanding || activeTab.url === "about:blank") {
                actionFn();
            } else {
                showConfirmModal("Are you sure you want to leave this page?", actionFn);
            }
        }

        // TAB MANAGEMENT
        function createNewTab(initialUrl = "") {
            const tabId = "tab_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4);
            const iframe = document.createElement("iframe");
            iframe.className = "viewport-frame";
            iframe.allow = "fullscreen; pointer-lock; autoplay; clipboard-read; autoplay; clipboard-write; microphone; camera; gamepad";
            iframe.allowFullscreen = true;
            iframe.style.display = "none";
            iframe.src = "about:blank";

            viewportContainer.appendChild(iframe);

            const tab = {
                id: tabId,
                title: "New Tab",
                url: initialUrl,
                iframe: iframe,
                isLanding: !initialUrl
            };

            tabs.push(tab);
            renderTabs();
            switchTab(tabId);

            if (initialUrl) {
                navigate(initialUrl);
            }
        }

        function switchTab(tabId) {
            activeTabId = tabId;
            tabs.forEach(t => {
                if (t.id === tabId) {
                    t.iframe.style.display = "block";
                    addressBar.value = t.isLanding ? "" : t.url;
                    if (t.isLanding) {
                        landingView.style.display = "flex";
                    } else {
                        landingView.style.display = "none";
                    }
                } else {
                    t.iframe.style.display = "none";
                }
            });
            renderTabs();
            updateStarState();
        }

        function closeTab(tabId, e) {
            if (e) e.stopPropagation();
            if (tabs.length === 1) {
                // If closing last tab, re-initialize it as clean landing
                const tab = tabs[0];
                tab.url = "";
                tab.title = "New Tab";
                tab.isLanding = true;
                tab.iframe.src = "about:blank";
                switchTab(tab.id);
                return;
            }

            const idx = tabs.findIndex(t => t.id === tabId);
            if (idx !== -1) {
                tabs[idx].iframe.remove();
                tabs.splice(idx, 1);
                if (activeTabId === tabId) {
                    const nextTab = tabs[Math.max(0, idx - 1)];
                    switchTab(nextTab.id);
                } else {
                    renderTabs();
                }
            }
        }

        function renderTabs() {
            tabListEl.innerHTML = "";
            tabs.forEach(t => {
                const el = document.createElement("div");
                el.className = "tab" + (t.id === activeTabId ? " active" : "");
                el.onclick = () => switchTab(t.id);

                const titleSpan = document.createElement("span");
                titleSpan.className = "tab-title";
                titleSpan.innerText = t.title || "New Tab";

                const closeBtn = document.createElement("button");
                closeBtn.className = "tab-close";
                closeBtn.innerText = "×";
                closeBtn.onclick = (e) => closeTab(t.id, e);

                el.appendChild(titleSpan);
                el.appendChild(closeBtn);
                tabListEl.appendChild(el);
            });
        }

        function getActiveTab() {
            return tabs.find(t => t.id === activeTabId);
        }

        // NAVIGATION LOGIC
        function navigate(targetUrl) {
            const tab = getActiveTab();
            if (!tab || !targetUrl.trim()) return;

            let finalUrl = targetUrl.trim();
            if (!/^https?:\\/\\//i.test(finalUrl) && finalUrl !== "about:blank" && !finalUrl.startsWith("file://")) {
                finalUrl = "https://" + finalUrl;
            }

            tab.url = finalUrl;
            tab.title = finalUrl.replace(/^https?:\\/\\//i, "").split("/")[0] || "Page";
            tab.isLanding = false;

            addressBar.value = finalUrl;
            landingView.style.display = "none";

            if (finalUrl === "about:blank") {
                tab.iframe.src = "about:blank";
            } else {
                tab.iframe.src = window.location.origin + "/render/" + finalUrl;
            }

            renderTabs();
            updateStarState();
        }

        function navigateFromAddressBar() { navigate(addressBar.value); }
        function launchFromLanding() { navigate(document.getElementById("landing-url-input").value); }
        function handleKeyPress(e) { if (e.key === "Enter") confirmAndExecute(navigateFromAddressBar); }

        function goBack() { const tab = getActiveTab(); if (tab) try { tab.iframe.contentWindow.history.back(); } catch(e){} }
        function goForward() { const tab = getActiveTab(); if (tab) try { tab.iframe.contentWindow.history.forward(); } catch(e){} }
        function reloadPage() { 
            confirmAndExecute(() => { 
                const tab = getActiveTab(); 
                if (tab) try { tab.iframe.contentWindow.location.reload(); } catch(e){ tab.iframe.src = tab.iframe.src; } 
            }); 
        }

        function goHome() {
            const tab = getActiveTab();
            if (tab) {
                tab.iframe.src = "about:blank";
                tab.url = "";
                tab.title = "New Tab";
                tab.isLanding = true;
                addressBar.value = "";
                landingView.style.display = "flex";
                renderTabs();
                updateStarState();
            }
        }

        // FILE IMPORT FEATURE (.htm, .html, .txt execution in about:blank)
        function triggerFileImport() {
            document.getElementById("file-importer").click();
        }

        function handleFileSelected(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function(e) {
                const fileContent = e.target.result;
                const tab = getActiveTab();
                if (!tab) return;

                tab.url = "file://" + file.name;
                tab.title = file.name;
                tab.isLanding = false;
                addressBar.value = tab.url;
                landingView.style.display = "none";

                // Load about:blank into iframe and write HTML content directly
                tab.iframe.src = "about:blank";
                setTimeout(() => {
                    try {
                        const doc = tab.iframe.contentDocument || tab.iframe.contentWindow.document;
                        doc.open();
                        doc.write(fileContent);
                        doc.close();
                    } catch(err) {
                        tab.iframe.srcdoc = fileContent;
                    }
                }, 100);

                renderTabs();
                updateStarState();
                event.target.value = ""; // reset file input
            };
            reader.readAsText(file);
        }

        // BOOKMARKS SYSTEM
        function renderBookmarks() {
            bookmarksListEl.innerHTML = "";
            bookmarks.forEach((bm, idx) => {
                const chip = document.createElement("div");
                chip.className = "bookmark-chip";
                
                const titleSpan = document.createElement("span");
                titleSpan.className = "bm-title";
                titleSpan.innerText = bm.title;
                titleSpan.onclick = () => confirmAndExecute(() => navigate(bm.url));

                const delBtn = document.createElement("span");
                delBtn.className = "bm-del";
                delBtn.innerText = "×";
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    bookmarks.splice(idx, 1);
                    localStorage.setItem("proxy_bookmarks", JSON.stringify(bookmarks));
                    renderBookmarks();
                    updateStarState();
                };

                chip.appendChild(titleSpan);
                chip.appendChild(delBtn);
                bookmarksListEl.appendChild(chip);
            });
        }

        function toggleBookmark() {
            const tab = getActiveTab();
            if (!tab || !tab.url || tab.isLanding) return;

            const existingIdx = bookmarks.findIndex(bm => bm.url === tab.url);
            if (existingIdx !== -1) {
                bookmarks.splice(existingIdx, 1);
            } else {
                bookmarks.push({ title: tab.title || tab.url, url: tab.url });
            }
            localStorage.setItem("proxy_bookmarks", JSON.stringify(bookmarks));
            renderBookmarks();
            updateStarState();
        }

        function updateStarState() {
            const tab = getActiveTab();
            if (tab && tab.url && bookmarks.some(bm => bm.url === tab.url)) {
                starBtn.classList.add("bookmarked");
            } else {
                starBtn.classList.remove("bookmarked");
            }
        }

        // FULLSCREEN HANDLER
        function handleFullscreenChange() {
          if (document.fullscreenElement || document.webkitFullscreenElement) {
            toolbar.style.display = "none";
            document.getElementById("tab-bar").style.display = "none";
            document.getElementById("bookmarks-bar").style.display = "none";
          } else {
            toolbar.style.display = "flex";
            document.getElementById("tab-bar").style.display = "flex";
            document.getElementById("bookmarks-bar").style.display = "flex";
          }
        }

        document.addEventListener("fullscreenchange", handleFullscreenChange);
        document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

        // DOWNLOAD MODAL
        function showTopDownloadModal(filename, fileContent) {
            const existing = document.getElementById('proxy-download-dialog-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'proxy-download-dialog-overlay';
            overlay.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.75); z-index:99999999; display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,sans-serif;';

            const modal = document.createElement('div');
            modal.style.cssText = 'background:#2b2a33; border:2px solid #00dd80; border-radius:12px; padding:24px; text-align:center; max-width:400px; width:90%; color:#fff; box-shadow:0 10px 30px rgba(0,0,0,0.8);';

            const title = document.createElement('h3');
            title.innerText = 'Download File Format';
            title.style.cssText = 'margin:0 0 10px 0; color:#00dd80; font-size:18px;';

            const desc = document.createElement('p');
            desc.innerText = 'Choose how you want to save this file:';
            desc.style.cssText = 'font-size:13px; color:#ccc; margin-bottom:20px; line-height:1.4;';

            const btnContainer = document.createElement('div');
            btnContainer.style.cssText = 'display:flex; gap:12px; justify-content:center;';

            const txtBtn = document.createElement('button');
            txtBtn.innerText = 'Download as .txt';
            txtBtn.style.cssText = 'background:#8ab4f8; color:#121212; border:none; padding:10px 16px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:13px; flex:1;';

            const htmBtn = document.createElement('button');
            htmBtn.innerText = 'Download as .htm';
            htmBtn.style.cssText = 'background:#00dd80; color:#121212; border:none; padding:10px 16px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:13px; flex:1;';

            btnContainer.appendChild(txtBtn);
            btnContainer.appendChild(htmBtn);
            modal.appendChild(title);
            modal.appendChild(desc);
            modal.appendChild(btnContainer);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            function processSave(ext) {
                try {
                    const mimeType = ext === 'txt' ? 'text/plain;charset=utf-8' : 'text/html;charset=utf-8';
                    const blob = new Blob([fileContent], { type: mimeType });
                    const bUrl = URL.createObjectURL(blob);
                    
                    let baseName = (filename || 'download').replace(/\\.(html?|txt)$/i, '');
                    const a = document.createElement('a');
                    a.href = bUrl;
                    a.download = baseName + '.' + ext;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(bUrl), 1000);
                } catch(err) {
                    alert('Save Error: ' + err.message);
                } finally {
                    overlay.remove();
                }
            }

            txtBtn.onclick = () => processSave('txt');
            htmBtn.onclick = () => processSave('htm');
        }

        // IFRAME MESSAGING (Multi-tab syncing)
        window.addEventListener("message", function(event) {
            if (!event.data) return;

            // Identify which tab sent the message
            const sourceIframeWindow = event.source;
            const senderTab = tabs.find(t => t.iframe.contentWindow === sourceIframeWindow);

            if (event.data.type === "PROXY_NAVIGATED") {
                if (senderTab) {
                    senderTab.url = event.data.url;
                    senderTab.title = event.data.url.replace(/^https?:\\/\\//i, "").split("/")[0] || "Page";
                    if (senderTab.id === activeTabId) {
                        addressBar.value = event.data.url;
                        updateStarState();
                    }
                    renderTabs();
                }
            } else if (event.data.type === "REQUEST_FULLSCREEN") {
                const docEl = document.documentElement;
                if (docEl.requestFullscreen) docEl.requestFullscreen();
                else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();
            } else if (event.data.type === "EXIT_FULLSCREEN") {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } else if (event.data.type === "PROMPT_HTML_DOWNLOAD") {
                showTopDownloadModal(event.data.filename, event.data.fileContent);
            }
        });

        // Initialize First Tab & Bookmarks
        createNewTab();
        renderBookmarks();
    </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 2. CLIENT-SIDE RUNTIME INTERCEPTOR
// ---------------------------------------------------------------------------
function getRuntimeScript(proxyOrigin, targetFullUrl, targetOrigin) {
  return `
<script>
(function() {
  const PROXY_PREFIX = "${proxyOrigin}/render/";
  const TARGET_ORIGIN = "${targetOrigin}";
  const CURRENT_TARGET_URL = "${targetFullUrl}";
  const TARGET_DIR = CURRENT_TARGET_URL.substring(0, CURRENT_TARGET_URL.lastIndexOf('/') + 1);

  if (window.parent !== window) {
    try { window.parent.postMessage({ type: 'PROXY_NAVIGATED', url: CURRENT_TARGET_URL }, '*'); } catch(e) {}
  }

  // Fullscreen API Interceptor
  const origRequestFullscreen = Element.prototype.requestFullscreen || Element.prototype.webkitRequestFullscreen;
  Element.prototype.requestFullscreen = function(options) {
    try { window.parent.postMessage({ type: 'REQUEST_FULLSCREEN' }, '*'); } catch(e) {}
    if (origRequestFullscreen) return origRequestFullscreen.call(this, options).catch(() => {});
    return Promise.resolve();
  };

  const origExitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
  document.exitFullscreen = function() {
    try { window.parent.postMessage({ type: 'EXIT_FULLSCREEN' }, '*'); } catch(e) {}
    if (origExitFullscreen) return origExitFullscreen.call(document);
    return Promise.resolve();
  };

  function rewriteUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith(PROXY_PREFIX)) return u;
    if (u.startsWith('http://') || u.startsWith('https://')) return PROXY_PREFIX + u;
    if (u.startsWith('/')) return PROXY_PREFIX + TARGET_ORIGIN + u;
    return PROXY_PREFIX + TARGET_DIR + u;
  }

  // Intercept Dynamic Images
  const origImgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (origImgSrcDesc && origImgSrcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: function() { return origImgSrcDesc.get.call(this); },
      set: function(val) {
        origImgSrcDesc.set.call(this, rewriteUrl(val));
      },
      configurable: true,
      enumerable: true
    });
  }

  // Intercept setAttribute for src, href, and srcset
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const lName = (name || '').toLowerCase();
    if ((lName === 'src' || lName === 'href') && typeof value === 'string') {
      return origSetAttribute.call(this, name, rewriteUrl(value));
    }
    if (lName === 'srcset' && typeof value === 'string') {
      const rewrittenSrcset = value.split(',').map(part => {
        const trimmed = part.trim().split(/\s+/);
        if (trimmed[0]) trimmed[0] = rewriteUrl(trimmed[0]);
        return trimmed.join(' ');
      }).join(', ');
      return origSetAttribute.call(this, name, rewrittenSrcset);
    }
    return origSetAttribute.call(this, name, value);
  };

  // In-Memory Blob Cache
  const activeBlobs = new Map();
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(blob) {
    const url = origCreateObjectURL.call(this, blob);
    if (blob instanceof Blob) {
      activeBlobs.set(url, blob);
    }
    return url;
  };

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = rewriteUrl(input);
    else if (input && input.url) input = new Request(rewriteUrl(input.url), input);
    return origFetch.call(this, input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    return origOpen.call(this, method, rewriteUrl(url), ...args);
  };

  window.open = function(url) {
    if (url) window.location.href = rewriteUrl(url);
    return window;
  };

  async function extractAndSendDownload(url, filename) {
    let textContent = null;

    if (activeBlobs.has(url)) {
      try {
        const blob = activeBlobs.get(url);
        textContent = await blob.text();
      } catch(e) {}
    }

    if (!textContent && (url.startsWith('blob:') || url.startsWith('data:'))) {
      try {
        const res = await origFetch(url);
        textContent = await res.text();
      } catch(e) {}
    }

    if (!textContent) {
      try {
        const fetchUrl = rewriteUrl(url);
        const res = await origFetch(fetchUrl);
        textContent = await res.text();
      } catch(e) {}
    }

    if (textContent && window.parent !== window) {
      window.parent.postMessage({
        type: 'PROMPT_HTML_DOWNLOAD',
        filename: filename || 'download',
        fileContent: textContent
      }, '*');
    }
  }

  function isHtmlOrDownload(anchor) {
    if (!anchor) return false;
    const href = anchor.getAttribute('href') || anchor.href || '';
    if (!href || href.startsWith('javascript:')) return false;

    const hasDownloadAttr = anchor.hasAttribute('download');
    const downloadName = (anchor.getAttribute('download') || '').toLowerCase();
    const isHtmlExt = href.toLowerCase().includes('.html') || href.toLowerCase().includes('.htm') || downloadName.endsWith('.html') || downloadName.endsWith('.htm');

    return hasDownloadAttr || isHtmlExt;
  }

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    if (isHtmlOrDownload(this)) {
      const filename = this.getAttribute('download') || (this.pathname ? this.pathname.split('/').pop() : 'download');
      extractAndSendDownload(this.href, filename);
      return;
    }
    return origClick.call(this);
  };

  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a) return;

    if (isHtmlOrDownload(a)) {
      e.preventDefault();
      e.stopPropagation();
      const filename = a.getAttribute('download') || (a.pathname ? a.pathname.split('/').pop() : 'download');
      extractAndSendDownload(a.href, filename);
      return;
    }

    if (a.href && !a.href.startsWith('javascript:')) {
      const parsed = new URL(a.href, window.location.href);
      if (!parsed.pathname.startsWith('/render/')) {
        e.preventDefault();
        let dest = parsed.href;
        if (parsed.origin === window.location.origin) {
          dest = parsed.pathname.startsWith('/') 
            ? TARGET_ORIGIN + parsed.pathname + parsed.search + parsed.hash
            : TARGET_DIR + parsed.pathname + parsed.search + parsed.hash;
        }
        window.location.href = PROXY_PREFIX + dest;
      }
    }
  }, true);

  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form.action) {
      const parsedAction = new URL(form.action, window.location.href);
      if (!parsedAction.pathname.startsWith('/render/')) {
        form.action = rewriteUrl(parsedAction.href);
      }
    }
  }, true);
})();
</script>
  `;
}
