/* Today's Dish: shared behaviour for every page (theme, toast, share sheet).
   Load as the first element inside <body> so the dark theme applies before paint. */

if (localStorage.getItem("dark") === "true") document.body.classList.add("dark");

function toggleDark() {
  document.body.classList.toggle("dark");
  localStorage.setItem("dark", document.body.classList.contains("dark"));
}

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.classList.remove("show"); }, 1600);
}

/* Overlays (share sheet, recipe sheet) */
function openOverlay(id) {
  const o = document.getElementById(id);
  if (!o) return;
  o.classList.add("open");
  document.body.style.overflow = "hidden";
  const close = o.querySelector(".close-btn");
  if (close) close.focus();
}
function closeOverlay(id) {
  const o = document.getElementById(id);
  if (!o) return;
  o.classList.remove("open");
  document.body.style.overflow = "";
}
document.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("overlay")) closeOverlay(e.target.id);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".overlay.open").forEach(o => closeOverlay(o.id));
});

/* Share */
// Pages can replace this with something specific (index.html names today's dishes)
let shareText = "Today's Dish 🍽️ One menu, everybody eats #TodaysDish";
function setShareText(text) { shareText = text; }

function siteRoot() {
  // Strip filename -> directory, ensure trailing slash
  return window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, "/");
}

// Share today's dated page (share/YYYY-MM-DD.html) when it exists: chat apps cache link
// previews per URL, so a new URL each day means the preview shows today's letterboard.
let shareUrl = null;
fetch("today.json", { cache: "no-cache" })
  .then(r => r.ok ? r.json() : null)
  .then(data => {
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return;
    const dated = siteRoot() + "share/" + data.date + ".html";
    return fetch(dated, { method: "HEAD", cache: "no-cache" }).then(r => { if (r.ok) shareUrl = dated; });
  })
  .catch(() => {});

function getShareUrl() {
  return shareUrl || siteRoot();
}

function openShareModal() {
  const url = getShareUrl();
  // Phones get their own share menu (all their apps and recent chats); computers get ours
  if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
    navigator.share({ title: "Today's Dish", text: shareText, url })
      .catch(err => { if (err.name !== "AbortError") showShareSheet(url); });
    return;
  }
  showShareSheet(url);
}
function showShareSheet(url) {
  document.getElementById("shareLink").value = url;
  openOverlay("shareOverlay");
}
function closeShareModal() { closeOverlay("shareOverlay"); }

async function copyShareLink() {
  const link = document.getElementById("shareLink").value;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Copied link ✅");
  } catch (e) {
    window.prompt("Copy this link:", link);
  }
}
function shareTo(platform) {
  const link = document.getElementById("shareLink").value;
  const text = encodeURIComponent(shareText);
  const u = encodeURIComponent(link);

  copyShareLink();

  let target = "";
  if (platform === "whatsapp") target = `https://wa.me/?text=${text}%20${u}`;
  if (platform === "facebook") target = `https://www.facebook.com/sharer/sharer.php?u=${u}`;
  if (platform === "x") target = `https://twitter.com/intent/tweet?text=${text}%20${u}`;
  if (platform === "telegram") target = `https://t.me/share/url?url=${u}&text=${text}`;
  if (platform === "email") target = `mailto:?subject=Today's%20Dish&body=${text}%0A%0A${u}`;
  if (platform === "reddit") target = `https://www.reddit.com/submit?url=${u}&title=${text}`;
  if (platform === "instagram") target = "https://www.instagram.com/";
  if (platform === "tiktok") target = "https://www.tiktok.com/";

  if (target) window.open(target, "_blank", "noopener,noreferrer");
}

// Official brand marks from Simple Icons (CC0, simpleicons.org). Telegram and Reddit
// marks are already circles, so they are drawn full size in their brand colour;
// the rest sit white on a brand-coloured circle. Email uses a plain envelope.
const SHARE_TARGETS = [
  { id: "whatsapp", label: "WhatsApp", color: "#25D366", path: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" },
  { id: "facebook", label: "Facebook", color: "#0866FF", path: "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" },
  { id: "x", label: "X", color: "#000000", path: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" },
  { id: "telegram", label: "Telegram", color: "#26A5E4", round: true, path: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" },
  { id: "email", label: "Email", color: "#A8261F" },
  { id: "reddit", label: "Reddit", color: "#FF4500", round: true, path: "M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" },
  { id: "instagram", label: "Instagram", color: "#E4405F", path: "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" },
  { id: "tiktok", label: "TikTok", color: "#000000", path: "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" }
];
const ENVELOPE = '<path d="M3 5.5h18v13H3z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>';

function shareIcon(t) {
  if (t.round) {
    return `<svg class="share-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="${t.color}" d="${t.path}"/></svg>`;
  }
  const glyph = t.path ? `<path fill="#fff" d="${t.path}"/>` : ENVELOPE;
  return `<span class="share-dot" style="background:${t.color}"><svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg></span>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const buttons = SHARE_TARGETS.map(t =>
    `<button type="button" class="share-icon" onclick="shareTo('${t.id}')">${shareIcon(t)}<span>${t.label}</span></button>`
  ).join("");

  document.body.insertAdjacentHTML("beforeend", `
    <div class="toast" id="toast" role="status">Copied link ✅</div>
    <div class="overlay" id="shareOverlay">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
        <div class="sheet-head">
          <div class="sheet-title" id="shareTitle">Tell your table</div>
          <button type="button" class="close-btn" onclick="closeShareModal()" aria-label="Close">✕</button>
        </div>
        <div class="share-grid">${buttons}</div>
        <div class="copy-row">
          <input class="copy-input" id="shareLink" readonly aria-label="Link to share">
          <button type="button" class="copy-btn" onclick="copyShareLink()">Copy</button>
        </div>
        <p class="modal-note">Instagram and TikTok can't take a shared link directly, so those buttons copy it for you to paste.</p>
      </div>
    </div>`);
});
