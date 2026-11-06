/* Sunpride guides: hash routing, sidebar, search, on-this-page links, prev/next. */
(function () {
  "use strict";

  // Section ids carry a "p-" prefix so a URL hash never matches an element
  // directly (the browser would otherwise jump to it before we route).
  function key(p) { return p.id.replace(/^p-/, ""); }
  var pages = Array.prototype.slice.call(document.querySelectorAll("section.page"));
  var byId = {};
  pages.forEach(function (p) { byId[key(p)] = p; });
  var order = pages.map(key);

  var nav = document.getElementById("nav");
  var toc = document.getElementById("toc");
  var search = document.getElementById("search");
  var results = document.getElementById("results");
  var navEmpty = document.getElementById("nav-empty");
  var body = document.body;

  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  }

  /* ---- sidebar, grouped in document order ---- */
  var groups = [];
  pages.forEach(function (p) {
    var g = p.getAttribute("data-group");
    var found = groups.filter(function (x) { return x.name === g; })[0];
    if (!found) { found = { name: g, items: [] }; groups.push(found); }
    found.items.push(p);
  });
  groups.forEach(function (g) {
    var wrap = document.createElement("div");
    wrap.className = "nav-group";
    var h = document.createElement("h4");
    h.textContent = g.name;
    wrap.appendChild(h);
    var ul = document.createElement("ul");
    g.items.forEach(function (p) {
      var li = document.createElement("li");
      li.setAttribute("data-page", key(p));
      var a = document.createElement("a");
      a.href = "#" + key(p);
      a.textContent = p.getAttribute("data-title");
      li.appendChild(a);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    nav.appendChild(wrap);
  });

  /* ---- search index: title + group + full text ---- */
  var index = pages.map(function (p) {
    return {
      id: key(p),
      title: p.getAttribute("data-title"),
      group: p.getAttribute("data-group"),
      text: (p.getAttribute("data-title") + " " + p.getAttribute("data-keywords") + " " + p.textContent).replace(/\s+/g, " "),
    };
  });

  function snippet(text, q) {
    var i = text.toLowerCase().indexOf(q);
    if (i < 0) return "";
    var start = Math.max(0, i - 60);
    var s = text.slice(start, i + q.length + 90);
    return (start > 0 ? "… " : "") + s.trim() + " …";
  }

  var activeResult = -1;
  function runSearch() {
    var q = search.value.trim().toLowerCase();
    var items = nav.querySelectorAll("li[data-page]");
    if (!q) {
      results.classList.remove("open");
      results.innerHTML = "";
      items.forEach(function (li) { li.classList.remove("hidden"); });
      navEmpty.classList.remove("show");
      return;
    }
    var hits = index.filter(function (d) { return d.text.toLowerCase().indexOf(q) !== -1; });
    var hitIds = hits.map(function (h) { return h.id; });
    items.forEach(function (li) {
      li.classList.toggle("hidden", hitIds.indexOf(li.getAttribute("data-page")) === -1);
    });
    navEmpty.classList.toggle("show", hits.length === 0);
    results.innerHTML = "";
    if (!hits.length) {
      var none = document.createElement("div");
      none.className = "none";
      none.textContent = "No pages match \u201c" + search.value.trim() + "\u201d. Try a shorter word.";
      results.appendChild(none);
    } else {
      hits.slice(0, 12).forEach(function (h) {
        var a = document.createElement("a");
        a.href = "#" + h.id;
        var strong = document.createElement("strong");
        strong.textContent = h.title;
        var span = document.createElement("span");
        span.textContent = h.group + (snippet(h.text, q) ? " \u2014 " + snippet(h.text, q) : "");
        a.appendChild(strong);
        a.appendChild(span);
        a.addEventListener("click", function () { search.value = ""; runSearch(); search.blur(); });
        results.appendChild(a);
      });
    }
    activeResult = -1;
    results.classList.add("open");
  }
  search.addEventListener("input", runSearch);
  search.addEventListener("keydown", function (e) {
    var links = results.querySelectorAll("a");
    if (e.key === "Escape") { search.value = ""; runSearch(); search.blur(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!links.length) return;
      e.preventDefault();
      activeResult = (activeResult + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
      links.forEach(function (l, i) { l.classList.toggle("active", i === activeResult); });
    }
    if (e.key === "Enter") {
      var target = links[activeResult >= 0 ? activeResult : 0];
      if (target) { e.preventDefault(); window.location.hash = target.getAttribute("href"); search.value = ""; runSearch(); search.blur(); }
    }
  });
  document.addEventListener("click", function (e) {
    if (!results.contains(e.target) && e.target !== search) results.classList.remove("open");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== search && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault(); search.focus();
    }
  });

  /* ---- prev / next, built once per page ---- */
  pages.forEach(function (p, i) {
    var pager = document.createElement("nav");
    pager.className = "pager";
    pager.setAttribute("aria-label", "Previous and next page");
    var prev = order[i - 1] ? byId[order[i - 1]] : null;
    var next = order[i + 1] ? byId[order[i + 1]] : null;
    var a = document.createElement("a");
    a.className = "prev" + (prev ? "" : " empty");
    if (prev) { a.href = "#" + key(prev); a.innerHTML = "<span>Previous</span><strong></strong>"; a.querySelector("strong").textContent = prev.getAttribute("data-title"); }
    var b = document.createElement("a");
    b.className = "next" + (next ? "" : " empty");
    if (next) { b.href = "#" + key(next); b.innerHTML = "<span>Next</span><strong></strong>"; b.querySelector("strong").textContent = next.getAttribute("data-title"); }
    pager.appendChild(a);
    pager.appendChild(b);
    p.appendChild(pager);
  });

  /* ---- on this page ---- */
  var tocObserver = null;
  function buildToc(page) {
    toc.innerHTML = "";
    var h = document.createElement("h5");
    h.textContent = "On this page";
    toc.appendChild(h);
    var heads = page.querySelectorAll("h2, h3");
    if (!heads.length) return;
    var ol = document.createElement("ol");
    heads.forEach(function (node) {
      if (!node.id) node.id = page.id + "-" + slug(node.textContent);
      var li = document.createElement("li");
      if (node.tagName === "H3") li.className = "sub";
      var a = document.createElement("a");
      a.href = "#" + key(page);
      a.setAttribute("data-anchor", node.id);
      a.textContent = node.textContent;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var y = node.getBoundingClientRect().top + window.pageYOffset - 70;
        window.scrollTo({ top: y, behavior: "smooth" });
      });
      li.appendChild(a);
      ol.appendChild(li);
    });
    toc.appendChild(ol);
    if (tocObserver) tocObserver.disconnect();
    tocObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        toc.querySelectorAll("a[data-anchor]").forEach(function (x) {
          x.classList.toggle("active", x.getAttribute("data-anchor") === en.target.id);
        });
      });
    }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
    heads.forEach(function (node) { tocObserver.observe(node); });
  }

  /* ---- routing ---- */
  function currentId() {
    var h = (window.location.hash || "").replace(/^#/, "").split("/")[0];
    return byId[h] ? h : order[0];
  }
  function show() {
    var id = currentId();
    var page = byId[id];
    pages.forEach(function (p) { p.hidden = p !== page; });
    nav.querySelectorAll("a").forEach(function (a) {
      a.classList.toggle("current", a.getAttribute("href") === "#" + id);
    });
    document.title = page.getAttribute("data-title") + " \u00b7 Sunpride guides";
    buildToc(page);
    window.scrollTo({ top: 0, behavior: "instant" });
    body.classList.remove("nav-open");
    // Open a section named in the URL (e.g. #messages/tags) by scrolling to its heading.
    var sub = (window.location.hash || "").split("/")[1];
    if (sub) {
      var target = document.getElementById(sub);
      if (target) setTimeout(function () { target.scrollIntoView({ block: "start" }); }, 0);
    }
  }
  window.addEventListener("hashchange", show);

  /* ---- mobile menu ---- */
  var menuBtn = document.getElementById("menu-btn");
  menuBtn.addEventListener("click", function () { body.classList.toggle("nav-open"); });
  document.getElementById("scrim").addEventListener("click", function () { body.classList.remove("nav-open"); });
  nav.addEventListener("click", function (e) { if (e.target.tagName === "A") body.classList.remove("nav-open"); });

  show();
})();
