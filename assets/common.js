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
  t.style.display = "block";
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.style.display = "none"; }, 1600);
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
let shareText = "Today's Dish 🍽️ Pick today's dish or cook with what you have:";
function setShareText(text) { shareText = text; }

function getShareUrl() {
  // Strip filename -> directory, ensure trailing slash
  return window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, "/");
}
function openShareModal() {
  document.getElementById("shareLink").value = getShareUrl();
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

const SHARE_ICONS = {
  whatsapp: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2a10 10 0 0 0-8.57 15.14L2 22l5-1.32A10 10 0 1 0 12 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M8.7 7.9c.2-.5.4-.6.8-.6h.6c.2 0 .4 0 .6.4l.8 1.9c.1.3.1.5 0 .7l-.4.5c-.1.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1.9.8 1.6 1.1 1.9 1.3.3.1.5.1.7-.1l.5-.6c.2-.2.4-.3.7-.2l2 .9c.3.1.5.3.5.5 0 .3-.1 1-.7 1.6-.5.6-1.2.6-1.6.5-.4-.1-1.8-.7-3.4-2.1-1.4-1.2-2.4-2.8-2.7-3.3-.3-.5-1.1-1.7-.6-2.6Z" fill="currentColor"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 22v-8h2.6l.4-3h-3V9.1c0-.9.3-1.6 1.6-1.6H17V5a22 22 0 0 0-2.7-.1c-2.7 0-4.6 1.7-4.6 4.8V11H7v3h2.7v8h3.8Z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H21l-7.7 8.8L22 22h-6.8l-5.3-6.9L3.9 22H2l8.3-9.5L2 2h6.9l4.8 6.2L18.9 2Zm-2.4 18h1.9L8.3 3.9H6.2L16.5 20Z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.7 4.3c.4-.2.8.2.7.6l-3.2 15.2c-.1.4-.5.6-.9.4l-4.6-3.4-2.2 2.1c-.3.3-.8.2-.9-.2l-1.2-4.2L4.7 12c-.4-.2-.4-.8 0-1l17-6.7ZM9.9 14.3l.9 3.2 1.6-1.5-.8-.6c-.5-.4-.4-1.2.2-1.4l5.5-2.6-6.4 2.9c-.7.3-1.2.9-1 1.9Z"/></svg>',
  email: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 6h16v12H4V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m4.5 7 7.5 6 7.5-6" stroke="currentColor" stroke-width="1.5"/></svg>',
  reddit: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 12.4c.6 0 1 .5 1 1.1 0 .5-.3 1-.8 1.1.1.4.1.7.1 1.1 0 3.1-3.7 5.7-8.3 5.7S3.7 19.8 3.7 16.7c0-.4 0-.7.1-1.1-.5-.2-.8-.6-.8-1.1 0-.6.4-1.1 1-1.1.3 0 .6.1.8.3 1.2-.9 3-1.5 5.1-1.7l.9-4.1c0-.2.2-.4.4-.3l3 .7c.2-.5.7-.9 1.3-.9.7 0 1.4.6 1.4 1.4 0 .7-.6 1.4-1.4 1.4-.5 0-1-.3-1.2-.7l-2.3-.5-.7 3.2c2.2.1 4.1.8 5.4 1.7.2-.2.5-.4.9-.4Zm-11 4.1c.5 0 .9-.4.9-.9s-.4-.9-.9-.9-.9.4-.9.9.4.9.9.9Zm6 0c.5 0 .9-.4.9-.9s-.4-.9-.9-.9-.9.4-.9.9.4.9.9.9Zm-6.1 2.1c1 .8 2.4 1.2 3.9 1.2s2.9-.4 3.9-1.2c.2-.2.2-.5 0-.7-.2-.2-.5-.2-.7 0-.7.6-1.9 1-3.2 1s-2.5-.4-3.2-1c-.2-.2-.5-.2-.7 0-.2.2-.2.5 0 .7Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><circle cx="16.5" cy="7.5" r="0.9" fill="currentColor"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3c.6 2.6 2.3 4.4 5 4.7v3c-1.9 0-3.5-.6-5-1.7V16c0 3.3-2.7 6-6 6S3 19.3 3 16s2.7-6 6-6c.6 0 1.1.1 1.6.2v3.3c-.5-.3-1-.5-1.6-.5-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3V3h3Z"/></svg>'
};
const SHARE_LABELS = { whatsapp: "WhatsApp", facebook: "Facebook", x: "X", telegram: "Telegram", email: "Email", reddit: "Reddit", instagram: "Instagram", tiktok: "TikTok" };

document.addEventListener("DOMContentLoaded", () => {
  const buttons = Object.keys(SHARE_ICONS).map(p =>
    `<button type="button" class="share-icon" onclick="shareTo('${p}')">${SHARE_ICONS[p]}${SHARE_LABELS[p]}</button>`
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
