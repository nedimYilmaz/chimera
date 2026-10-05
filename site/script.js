// Progressive enhancement only: the page is complete without this file.
(function () {
  "use strict";

  // Smooth scrolling is armed by a click on an in-page link (see styles.css), never by page load: a shared
  // deep link such as features.html#secrets sits dozens of screens down and must land at once. Chrome runs
  // the fragment scroll after the load event, so arming on load would still animate that long traversal.
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (a) document.documentElement.classList.add("smooth-anchors");
  }, true);

  // Keep the reader in one workflow when switching between inline films.
  document.querySelectorAll("video").forEach(function (video) {
    video.addEventListener("play", function () {
      document.querySelectorAll("video").forEach(function (other) {
        if (other !== video) other.pause();
      });
    });
  });

  // Copy buttons on code blocks.
  var live = document.createElement("p");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
  document.body.appendChild(live);

  document.querySelectorAll("pre[data-copyable]").forEach(function (pre) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy command to clipboard");
    btn.addEventListener("click", function () {
      var text = pre.querySelector("code").textContent;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = "Copied";
        live.textContent = "Command copied to clipboard";
        setTimeout(function () { btn.textContent = "Copy"; live.textContent = ""; }, 1800);
      }, function () {
        live.textContent = "Copy failed. Select the text and copy it manually.";
      });
    });
    pre.parentNode.appendChild(btn);
  });

  // Screenshot lightbox. Without JS the link opens the PNG itself.
  var dialog = document.querySelector("dialog.lightbox");
  if (dialog && typeof dialog.showModal === "function") {
    var big = dialog.querySelector("img");
    var cap = dialog.querySelector(".lightbox__cap");
    document.querySelectorAll("a[data-zoom]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return;
        ev.preventDefault();
        var img = a.querySelector("img");
        big.src = a.getAttribute("href");
        big.alt = img ? img.alt : "";
        var fig = a.closest("figure");
        var fc = fig && fig.querySelector("figcaption");
        cap.textContent = fc ? fc.textContent : "";
        dialog.showModal();
      });
    });
    // A click on the backdrop lands on the dialog element itself.
    dialog.addEventListener("click", function (ev) {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", function () { big.removeAttribute("src"); });
  }

  // Feature guide: search box and group chips. Filtering only toggles [hidden]; nothing is removed
  // from the page, so the guide is complete without this code and anchors always have a target.
  var tools = document.getElementById("guide-tools");
  var guide = document.querySelector(".guide__body");
  if (tools && guide) {
    var cats = [].slice.call(guide.querySelectorAll("article.cat")).map(function (el) {
      var parts = [el.getAttribute("data-kw") || ""];
      // The source-path list would make "app" or "src" match every area.
      [].forEach.call(el.children, function (c) {
        if (!c.classList.contains("src")) parts.push(c.textContent);
      });
      return {
        el: el,
        fam: el.closest("section.fam").getAttribute("data-family"),
        text: parts.join(" ").toLowerCase(),
        details: el.querySelector("details.adv"),
        auto: false,
        adv: [].slice.call(el.querySelectorAll("details.adv li")).map(function (li) {
          return { el: li, text: li.textContent.toLowerCase() };
        })
      };
    });
    var fams = [].slice.call(guide.querySelectorAll("section.fam[data-family]")).map(function (el) {
      return { el: el, id: el.getAttribute("data-family"), title: el.querySelector("h2").textContent };
    });

    var query = "";
    var famSel = "";

    var field = document.createElement("div");
    field.className = "gsearch";
    var label = document.createElement("label");
    label.setAttribute("for", "guide-q");
    label.textContent = "Search the guide";
    var input = document.createElement("input");
    input.type = "search";
    input.id = "guide-q";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Try “cron”, “OAuth”, “budget” or “worktree”";
    field.appendChild(label);
    field.appendChild(input);

    var chips = document.createElement("div");
    chips.className = "chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Show one group of areas");
    var chipEls = [{ id: "", title: "All areas" }].concat(fams).map(function (f) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = f.title;
      b.addEventListener("click", function () { famSel = f.id; apply(); });
      chips.appendChild(b);
      return { id: f.id, el: b };
    });

    var count = document.createElement("p");
    count.className = "fine";
    count.hidden = true;

    var empty = document.createElement("p");
    empty.className = "gempty";
    empty.hidden = true;
    var emptyText = document.createElement("span");
    var clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear filters";
    clear.addEventListener("click", function () { reset(); input.focus(); });
    empty.appendChild(emptyText);
    empty.appendChild(clear);

    tools.appendChild(field);
    tools.appendChild(chips);
    tools.appendChild(count);
    tools.appendChild(empty);

    var say;
    var touched = false;
    function apply() {
      var tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      var seen = {};
      cats.forEach(function (c) {
        var ok = (!famSel || c.fam === famSel) && tokens.every(function (t) { return c.text.indexOf(t) !== -1; });
        c.el.hidden = !ok;
        seen[c.el.id] = ok;
        if (ok) shown++;
        // Mark the smaller capabilities that match the whole query, and open the list that holds them.
        var hit = false;
        c.adv.forEach(function (a) {
          var h = ok && tokens.length > 0 && tokens.every(function (t) { return a.text.indexOf(t) !== -1; });
          a.el.classList.toggle("is-hit", h);
          hit = hit || h;
        });
        if (c.details) {
          if (hit && !c.details.open) { c.details.open = true; c.auto = true; }
          else if (!hit && c.auto) { c.details.open = false; c.auto = false; }
        }
      });
      fams.forEach(function (f) {
        f.el.hidden = !cats.some(function (c) { return c.fam === f.id && seen[c.el.id]; });
      });
      [].forEach.call(document.querySelectorAll(".toc li[data-for]"), function (li) {
        li.hidden = !seen[li.getAttribute("data-for")];
      });
      [].forEach.call(document.querySelectorAll(".toc__fam"), function (g) {
        g.hidden = !g.querySelector("li:not([hidden])");
      });
      chipEls.forEach(function (c) { c.el.setAttribute("aria-pressed", String(c.id === famSel)); });

      var active = tokens.length > 0 || famSel !== "";
      count.hidden = !active;
      count.textContent = shown + " of " + cats.length + " areas match.";
      empty.hidden = shown !== 0;
      emptyText.textContent = "No area matches that search.";
      clearTimeout(say);
      // Stay silent on page load: announcing "all areas" on every view is noise for a screen reader.
      if (!active && !touched) return;
      touched = true;
      say = setTimeout(function () {
        live.textContent = active ? shown + " of " + cats.length + " areas match" : "Showing all " + cats.length + " areas";
      }, 400);
    }

    function reset() {
      query = "";
      famSel = "";
      input.value = "";
      apply();
    }

    input.addEventListener("input", function () { query = input.value; apply(); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && (query || famSel)) { ev.preventDefault(); reset(); }
    });
    apply();

    // A deep link to an area the current filter hides clears the filter instead of landing on nothing.
    function reveal() {
      var id = "";
      try { id = decodeURIComponent(location.hash.slice(1)); } catch (e) { return; }
      var target = id && document.getElementById(id);
      if (target && target.closest("[hidden]")) { reset(); target.scrollIntoView(); }
    }
    window.addEventListener("hashchange", reveal);
    reveal();

    // The contents list is open on wide screens and one tap away on narrow ones.
    var toc = document.querySelector(".toc__d");
    if (toc && window.matchMedia) {
      var wide = window.matchMedia("(min-width: 62rem)");
      toc.open = wide.matches;
      var follow = function () { toc.open = wide.matches; };
      if (wide.addEventListener) wide.addEventListener("change", follow);
      else if (wide.addListener) wide.addListener(follow);
      toc.addEventListener("click", function (ev) {
        if (!wide.matches && ev.target.closest && ev.target.closest("a")) toc.open = false;
      });
    }
  }
})();
