/*
 * PaHub frontend logic (connected to the backend)
 * ================================================
 * The old hardcoded USERS / NEEDS data is now replaced with /api endpoint calls.
 * Data lives in SQLite and persists across refreshes. The account you sign up / sign in with is the "current user".
 */

/* ---------- Global state ---------- */
var signedIn = false;            // whether the user is signed in
var meUser = null;               // current signed-in user (from /api/me)
var SECTIONS = [];               // section list (from /api/sections)
var navHistory = [];             // simple back stack

var state = {
  sectionId: null, sectionQuery: '', sectionSort: 'hot',
  profileId: null, profileTab: null, profileQuery: '',
  detail: null, need: null, needReply: null,
  assetFile: null, reportFile: null,
};

/* ---------- Utilities ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function userName(u) {
  return ((u.name || '') + ' ' + (u.college || '')).trim();
}

function timeAgo(iso) {
  if (!iso) return '';
  var s = iso;
  // backend stores timezone-less UTC; append Z so the browser parses it as UTC
  if (!/[zZ]$/.test(s) && !/[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  var diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
  if (diff < 604800) return Math.floor(diff / 86400) + ' day ago';
  return Math.floor(diff / 604800) + ' wk ago';
}

var toastTimer = null;
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function requireSignIn() {
  if (signedIn) return true;
  openLogin();
  toast('Please sign in first');
  return false;
}

/* ---------- API requests ---------- */
async function api(path, method, body) {
  var opt = { method: method || 'GET', credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  try {
    var res = await fetch(path, opt);
    var data = await res.json();
    if (!res.ok && data && data.error) {
      return { error: data.error };
    }
    return data;
  } catch (e) {
    return { error: "Can't reach the backend, make sure python app.py is running" };
  }
}

async function uploadForm(path, formData) {
  try {
    var res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: formData });
    var data = await res.json();
    if (!res.ok && data && data.error) return { error: data.error };
    return data;
  } catch (e) {
    return { error: "Can't reach the backend, make sure python app.py is running" };
  }
}

/* ---------- Section helpers ---------- */
function secInfo(id) {
  for (var i = 0; i < SECTIONS.length; i++) {
    var big = SECTIONS[i];
    for (var j = 0; j < big.subs.length; j++) {
      if (big.subs[j].id === id) {
        return { big: big.name, name: big.subs[j].name, desc: big.subs[j].desc };
      }
    }
  }
  return { big: '', name: id, desc: '' };
}
function secName(id) { return secInfo(id).name; }
function secPath(id) {
  var s = secInfo(id);
  return s.big ? s.big + ' › ' + s.name : s.name;
}

/* ---------- Routing (show / go / render) ---------- */
function show(id) {
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active');
  var el = document.getElementById('view-' + id);
  if (el) el.classList.add('active');
}

function go(id, params) {
  if (id !== 'home' && !signedIn) { openLogin(); toast('Please sign in first'); return; }
  navHistory.push({ view: id, params: params || {} });
  render(id, params || {});
}

function historyBack() {
  navHistory.pop();
  var last = navHistory[navHistory.length - 1];
  if (!last) { render('home', {}); return; }
  render(last.view, last.params);
}

function render(id, p) {
  show(id);
  if (id === 'hub') renderHub();
  if (id === 'section') renderSection(p.id);
  if (id === 'profile') renderProfile(p.id);
  if (id === 'search') renderSearch(p.q);
  if (id === 'needs') renderNeeds();
}

/* ---------- Home ---------- */
function renderHub() {
  var html = SECTIONS.map(function (big) {
    var subs = big.subs.map(function (s) {
      return '<div class="sub-item" onclick="go(\'section\',{id:\'' + s.id + '\'})">' + esc(s.name) + '</div>';
    }).join('');
    return '<div class="section-card"><div class="big-name">' + esc(big.name) + '</div><div class="sub-list">' + subs + '</div></div>';
  }).join('');
  document.getElementById('section-grid').innerHTML = html;
}

/* ---------- Section content ---------- */
async function renderSection(id) {
  state.sectionId = id;
  state.sectionQuery = '';
  state.sectionSort = 'hot';
  var qel = document.getElementById('sec-q'); if (qel) qel.value = '';
  var s = secInfo(id);
  document.getElementById('sec-crumb').textContent = s.big ? s.big + ' › ' + s.name : s.name;
  document.getElementById('sec-head').innerHTML =
    '<div><h1>' + esc(s.name) + '</h1><div class="sub">' + esc(s.desc) + ' · click to view content</div></div>';
  document.querySelectorAll('#sec-sort .sort-tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-sort') === 'hot');
  });
  await drawSectionList();
}

async function drawSectionList() {
  var id = state.sectionId;
  var q = (state.sectionQuery || '').trim();
  var sort = state.sectionSort;
  var url = '/api/items?section=' + encodeURIComponent(id) + '&sort=' + sort + (q ? '&q=' + encodeURIComponent(q) : '');
  var data = await api(url);
  var box = document.getElementById('sec-list');
  if (data.error) { box.innerHTML = '<div class="empty">' + esc(data.error) + '</div>'; return; }
  var items = data.items || [];
  box.innerHTML = items.map(contentRow).join('') ||
    '<div class="empty">' + (q ? 'No matching content in this section, try a different word.' : 'This section has no content yet, be the first contributor.') + '</div>';
}

function filterSection(v) { state.sectionQuery = (v || '').trim(); drawSectionList(); }

function sortSection(mode) {
  state.sectionSort = mode;
  document.querySelectorAll('#sec-sort .sort-tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-sort') === mode);
  });
  drawSectionList();
}

/* ---------- Author profile ---------- */
async function renderProfile(id) {
  state.profileId = id;
  state.profileTab = null;
  state.profileQuery = '';
  var qel = document.getElementById('profile-q');
  var body = document.getElementById('profile-body');

  var data = await api('/api/users/' + id);
  if (data.error) { body.innerHTML = '<div class="empty">' + esc(data.error) + '</div>'; return; }
  var u = data.user;
  var isMe = !!(meUser && meUser.id === u.id);
  var followed = !!u.is_followed;

  var assetLabel = isMe ? 'View My Asset' : 'View His/Her Asset';
  var commentLabel = isMe ? 'View My Comment' : 'View His/Her Comment';
  var followingHTML = isMe
    ? '<div class="chooser-card" data-type="following" onclick="showProfilePane(\'following\')">List You Followed</div>'
    : '';
  var bookmarkHTML = isMe
    ? '<div class="chooser-card" data-type="bookmark" onclick="showProfilePane(\'bookmark\')">My Bookmark</div>'
    : '';

  var hero = '<div class="profile-hero">'
    + '<div class="ph-top">'
    +   '<span class="avatar lg ' + lvClass(u.level) + '">' + esc(u.letter) + '</span>'
    +   '<div style="flex:1">'
    +     '<div class="ph-name">' + esc(u.name) + ' <span class="level ' + lvClass(u.level) + '">' + esc(u.level) + '</span>' + (isMe ? '<span class="chip">This is you</span>' : '') + '</div>'
    +     '<div class="ph-sub">' + (u.college ? esc(u.college) : '') + '</div>'
    +   '</div>'
    +   (isMe ? '' : '<button class="btn ' + (followed ? 'btn-outline' : 'btn-primary') + '" onclick="toggleFollow(this,' + u.id + ')">' + (followed ? '✓ Following' : '＋ Follow') + '</button>')
    + '</div>'
    + (isMe
      ? '<div class="ph-bio" id="bio-view" style="cursor:pointer" onclick="editBio()">' + (u.bio ? esc(u.bio) : '<span style="color:var(--text-3)">Introduce Yourself</span>') + '</div>'
        + '<button class="btn btn-outline" style="margin:10px 0 0" onclick="editBio()">' + (u.bio ? 'Change Your Portrait' : 'Introduce Yourself') + '</button>'
        + '<div id="bio-editor" style="display:none;margin-top:10px">'
        +   '<textarea id="bio-input" class="bio-input" placeholder="Introduce Yourself">' + esc(u.bio) + '</textarea>'
        +   '<div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-primary" style="padding:7px 16px;font-size:13px" onclick="saveBio()">Save</button><button class="btn btn-outline" style="padding:6px 14px;font-size:13px" onclick="cancelBio()">Cancel</button></div>'
        + '</div>'
      : '<div class="ph-bio">' + esc(u.bio) + '</div>')
    + '<div class="ph-stats">'
    +   '<div class="s"><b>' + u.stats.uploads + '</b> uploads</div>'
    +   '<div class="s"><b>' + u.stats.likes + '</b> stars received</div>'
    +   '<div class="s"><b>' + u.stats.followers + '</b> followers</div>'
    + '</div>'
    + '</div>';

  body.innerHTML = hero
    + '<div class="searchbar" style="margin:14px 0">'
    +   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>'
    +   '<input type="text" id="profile-q" placeholder="Get Your Resource" oninput="filterProfile(this.value)">'
    + '</div>'
    + '<div class="profile-chooser">'
    +   '<div class="chooser-card" data-type="asset" onclick="showProfilePane(\'asset\')">' + assetLabel + '</div>'
    +   '<div class="chooser-card" data-type="comment" onclick="showProfilePane(\'comment\')">' + commentLabel + '</div>'
    +   followingHTML
    +   bookmarkHTML
    + '</div>'
    + '<div id="profile-list"></div>';
}

async function drawProfileList() {
  if (state.profileTab === 'following') { await drawFollowingList(); return; }
  if (state.profileTab === 'bookmark') { await drawBookmarkList(); return; }
  var q = (state.profileQuery || '').trim();
  var box = document.getElementById('profile-list');
  if (!q && !state.profileTab) { box.innerHTML = ''; return; }
  var url = '/api/users/' + state.profileId + '/items';
  if (q) url += '?q=' + encodeURIComponent(q);
  else url += '?type=' + state.profileTab;
  var data = await api(url);
  if (data.error) { box.innerHTML = '<div class="empty">' + esc(data.error) + '</div>'; return; }
  var items = data.items || [];
  box.innerHTML = items.map(contentRow).join('') ||
    '<div class="empty">' + (q ? 'No matching content, try a different word.' : 'Nothing here yet.') + '</div>';
}

async function drawFollowingList() {
  var box = document.getElementById('profile-list');
  var data = await api('/api/users/' + state.profileId + '/following');
  var list = data.following || [];
  box.innerHTML = list.map(function (u) {
    return '<div class="search-result" onclick="go(\'profile\',{id:' + u.id + '})">'
      + '<span class="avatar md ' + lvClass(u.level) + '">' + esc(u.letter) + '</span>'
      + '<div class="sr-main"><div class="sr-name">' + esc(userName(u)) + ' <span class="level ' + lvClass(u.level) + '">' + esc(u.level) + '</span></div>'
      + '<div class="sr-bio">' + esc(u.bio || '') + '</div></div>'
      + '<span style="color:var(--text-3)">→</span></div>';
  }).join('') || '<div class="empty">You haven\'t followed anyone yet.</div>';
}

async function drawBookmarkList() {
  var box = document.getElementById('profile-list');
  var data = await api('/api/me/bookmarks');
  if (data.error) { box.innerHTML = '<div class="empty">' + esc(data.error) + '</div>'; return; }
  var items = data.items || [];
  box.innerHTML = items.map(contentRow).join('') || '<div class="empty">You haven\'t bookmarked anything yet.</div>';
}

function filterProfile(v) { state.profileQuery = (v || '').trim(); drawProfileList(); }

function showProfilePane(type) {
  state.profileTab = type;
  document.querySelectorAll('.chooser-card').forEach(function (c) {
    c.classList.toggle('active', c.getAttribute('data-type') === type);
  });
  drawProfileList();
}

async function toggleFollow(btn, uid) {
  var data = await api('/api/users/' + uid + '/follow', 'POST');
  if (data.error) { toast(data.error); return; }
  btn.textContent = data.followed ? '✓ Following' : '＋ Follow';
  btn.classList.toggle('btn-primary', !data.followed);
  btn.classList.toggle('btn-outline', data.followed);
  toast(data.followed ? 'Followed' : 'Unfollowed');
}

function editBio() {
  document.getElementById('bio-view').style.display = 'none';
  document.getElementById('bio-editor').style.display = 'block';
  document.getElementById('bio-input').focus();
}

async function saveBio() {
  var v = document.getElementById('bio-input').value.trim();
  var data = await api('/api/users/' + state.profileId + '/bio', 'PUT', { bio: v });
  if (data.error) { toast(data.error); return; }
  toast(v ? 'Bio saved' : 'Bio cleared');
  renderProfile(state.profileId);
}

function cancelBio() { renderProfile(state.profileId); }

/* ---------- Search ---------- */
async function onSuggest(v) {
  var box = document.getElementById('home-suggest');
  v = (v || '').trim();
  if (!v) { box.classList.remove('show'); box.innerHTML = ''; return; }
  if (!signedIn) {
    box.innerHTML = '<div class="row" onclick="openLogin()"><span>Sign in to search resources</span><span class="sub">Please sign in first</span></div>';
    box.classList.add('show');
    return;
  }
  var lv = v.toLowerCase();

  var subs = [];
  SECTIONS.forEach(function (big) {
    big.subs.forEach(function (s) { subs.push({ big: big, sub: s }); });
  });
  var secs = subs.filter(function (o) {
    return o.sub.name.indexOf(v) >= 0 || o.sub.desc.indexOf(v) >= 0 || o.big.name.toLowerCase().indexOf(lv) >= 0;
  });

  var data = await api('/api/search?q=' + encodeURIComponent(v));
  var its = data.items || [];
  var us = data.users || [];

  var html = '';
  if (its.length) {
    html += '<div class="hd">Content</div>' + its.slice(0, 5).map(function (o) {
      return '<div class="row" onclick="suggestOpenDetail(' + o.id + ')"><span>' + esc(o.title) + '</span><span class="sub">' + esc(userName(o.author)) + '</span></div>';
    }).join('');
  }
  if (secs.length) {
    html += '<div class="hd">Sections</div>' + secs.map(function (o) {
      return '<div class="row" onclick="go(\'section\',{id:\'' + o.sub.id + '\'})"><span>' + o.big.name + ' › ' + o.sub.name + '</span><span class="sub">' + esc(o.sub.desc) + '</span></div>';
    }).join('');
  }
  if (us.length) {
    html += '<div class="hd">Classmates</div>' + us.slice(0, 3).map(function (u) {
      return '<div class="row" onclick="go(\'profile\',{id:' + u.id + '})"><span class="avatar sm ' + lvClass(u.level) + '">' + esc(u.letter) + '</span><span>' + esc(userName(u)) + ' <span class="level ' + lvClass(u.level) + '">' + esc(u.level) + '</span></span><span class="sub">' + esc((u.bio || '').slice(0, 12)) + '…</span></div>';
    }).join('');
  }
  html += '<div class="row" data-q="' + esc(v) + '" onclick="doSearch(this.dataset.q)"><span>Search "' + esc(v) + '"</span><span class="sub">Enter</span></div>';
  box.innerHTML = html;
  box.classList.add('show');
}

function suggestOpenDetail(id) {
  document.getElementById('home-suggest').classList.remove('show');
  openDetail(id);
}

function doSearch(v) {
  if (v && v.trim()) {
    document.getElementById('home-suggest').classList.remove('show');
    go('search', { q: v.trim() });
  }
}

async function renderSearch(q) {
  q = (q || '').trim();
  var data = await api('/api/search?q=' + encodeURIComponent(q));
  var users = data.users || [], items = data.items || [];
  document.getElementById('search-summary').textContent = q
    ? 'Search "' + q + '" · found ' + (users.length + items.length) + ' result(s)'
    : 'Get Your Resource';

  var html = '';
  if (users.length) {
    html += '<div class="hub-sub" style="margin:0 0 10px">Classmates</div>' + users.map(function (u) {
      return '<div class="search-result" onclick="go(\'profile\',{id:' + u.id + '})">'
        + '<span class="avatar md ' + lvClass(u.level) + '">' + esc(u.letter) + '</span>'
        + '<div class="sr-main"><div class="sr-name">' + esc(userName(u)) + ' <span class="level ' + lvClass(u.level) + '">' + esc(u.level) + '</span></div>'
        + '<div class="sr-bio">' + esc(u.bio || '') + '</div></div>'
        + '<span style="color:var(--text-3)">→</span></div>';
    }).join('');
  }
  if (items.length) {
    html += '<div class="hub-sub" style="margin:16px 0 10px">Content</div>' + items.map(contentRow).join('');
  }
  document.getElementById('search-results').innerHTML = html || '<div class="empty">'
    + 'Haven\'t found this resource yet.'
    + '<div style="margin-top:10px"><span class="who-link" onclick="openNeedPost()">go and post needs!</span></div>'
    + '</div>';
}

function lvClass(level) { return 'lv-' + (level || 'Primary'); }

/* ---------- Content row ---------- */
function contentRow(it) {
  var tag = it.type === 'asset' ? 'asset' : 'post';
  var starred = !!it.starred;
  var n = it.likes || 0;
  var authorName = (it.author && it.author.name) || '';
  return '<div class="item-row" onclick="openDetail(' + it.id + ')">'
    + '<div class="main">'
    +   '<div class="ctitle"><span class="type-tag ' + it.type + '">' + tag + '</span>' + (it.type === 'asset' ? 'asset/' : '') + esc(it.title) + '</div>'
    +   (it.type === 'asset' && it.desc ? '<div class="cdesc">' + esc(it.desc) + '</div>' : '')
    +   '<div class="cmeta"><span>star count: ' + n + '</span><span>views ' + it.views + '</span><span>comments ' + (it.comment_count || 0) + '</span><span class="who-link" onclick="event.stopPropagation();goUser(' + it.user_id + ')">by ' + esc(authorName) + '</span></div>'
    + '</div>'
    + '<button class="star-btn' + (starred ? ' on' : '') + '" data-likes="' + (it.likes || 0) + '" onclick="event.stopPropagation();toggleStar(this,' + it.id + ')" title="Star">★</button>'
    + '</div>';
}

async function toggleStar(btn, itemId) {
  var data = await api('/api/items/' + itemId + '/star', 'POST');
  if (data.error) { toast(data.error); return; }
  btn.classList.toggle('on', !!data.starred);
  btn.setAttribute('data-likes', data.star_count);
  var row = btn.closest('.item-row');
  if (row) {
    var m = row.querySelector('.cmeta span');
    if (m) m.textContent = 'star count: ' + data.star_count;
  }
  toast(data.starred ? 'Starred' : 'Unstarred');
}

async function toggleStarDetail(btn) {
  var it = state.detail; if (!it) return;
  var data = await api('/api/items/' + it.id + '/star', 'POST');
  if (data.error) { toast(data.error); return; }
  btn.classList.toggle('on', !!data.starred);
  btn.setAttribute('data-likes', data.star_count);
  document.getElementById('detail-star-n').textContent = data.star_count;
  state.detail.likes = data.star_count;
  state.detail.starred = data.starred;
  toast(data.starred ? 'Starred' : 'Unstarred');
}

async function toggleBookmarkDetail(btn) {
  var it = state.detail; if (!it) return;
  var data = await api('/api/items/' + it.id + '/bookmark', 'POST');
  if (data.error) { toast(data.error); return; }
  btn.textContent = data.bookmarked ? 'Bookmarked' : 'Bookmark';
  toast(data.bookmarked ? 'Bookmarked' : 'Bookmark removed');
}

async function deleteItem() {
  var it = state.detail; if (!it) return;
  if (!confirm('Delete this content? This cannot be undone.')) return;
  var data = await api('/api/items/' + it.id, 'DELETE');
  if (data.error) { toast(data.error); return; }
  closeModal('modal-detail');
  state.detail = null;
  toast('Deleted');
  var last = navHistory[navHistory.length - 1];
  if (last) render(last.view, last.params); else render('home', {});
}

/* ---------- Content detail ---------- */
async function openDetail(itemId) {
  if (!requireSignIn()) return;
  closeModal('modal-need');
  var data = await api('/api/items/' + itemId);
  if (data.error) { toast(data.error); return; }
  var it = data.item;
  state.detail = it;

  var delBtn = document.getElementById('detail-delete');
  if (delBtn) delBtn.style.display = (meUser && it.user_id === meUser.id) ? 'inline-flex' : 'none';

  document.getElementById('detail-title').textContent = (it.type === 'asset' ? 'asset/' : '') + it.title;
  var detailLv = lvClass(it.author.level);
  document.getElementById('detail-letter').textContent = it.author.letter;
  document.getElementById('detail-letter').className = 'avatar sm ' + detailLv;
  document.getElementById('detail-author').textContent = it.author.name;
  var detailLevelEl = document.getElementById('detail-level');
  detailLevelEl.textContent = it.author.level;
  detailLevelEl.className = 'level ' + detailLv;
  document.getElementById('detail-sec').textContent = it.sec_path;

  var body;
  if (it.type === 'asset') {
    body = (it.desc ? '<div style="color:var(--text);margin-bottom:10px">' + esc(it.desc) + '</div>' : '');
    if (it.file_name) {
      body += '<div style="text-align:center"><a class="btn btn-primary" style="text-decoration:none" href="/api/items/' + it.id + '/download">Download attachment: ' + esc(it.file_name) + '</a></div>';
    } else {
      body += '<div style="padding:18px;border:1px dashed var(--border);border-radius:10px;text-align:center;color:var(--text-3)">This resource has no attachment</div>';
    }
  } else {
    body = '<div style="color:var(--text)">' + esc(it.title) + '</div>';
  }
  document.getElementById('detail-body').innerHTML = body;

  var starBtn = document.getElementById('detail-star');
  starBtn.setAttribute('data-likes', it.likes || 0);
  starBtn.classList.toggle('on', !!it.starred);
  document.getElementById('detail-star-n').textContent = it.likes || 0;

  var bmBtn = document.getElementById('detail-bookmark');
  bmBtn.textContent = it.bookmarked ? 'Bookmarked' : 'Bookmark';

  var comments = it.comments || [];
  document.getElementById('detail-comments').innerHTML = comments.map(commentHTML).join('')
    || '<div class="empty" style="padding:20px 0">No comments yet, be the first~</div>';

  openModal('modal-detail');
}

function commentHTML(c) {
  return '<div class="comment">'
    + '<span class="avatar sm ' + lvClass(c.author_level) + '" onclick="goUser(' + c.author_id + ')" title="View profile" style="cursor:pointer">' + esc((c.author || '')[0]) + '</span>'
    + '<div><span class="who"><span class="who-link" onclick="goUser(' + c.author_id + ')">' + esc(c.author) + '</span>' + '<span class="time">' + timeAgo(c.time) + '</span></span>'
    + '<div class="text">' + esc(c.text) + '</div></div></div>';
}

async function addComment() {
  var input = document.getElementById('detail-comment-input');
  var v = input.value.trim();
  if (!v) { toast('Comment cannot be empty'); return; }
  var it = state.detail; if (!it) return;
  var data = await api('/api/items/' + it.id + '/comments', 'POST', { text: v });
  if (data.error) { toast(data.error); return; }
  input.value = '';
  var box = document.getElementById('detail-comments');
  var empty = box.querySelector('.empty');
  if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend', commentHTML(data.comment));
  toast('Comment posted');
}

function goAuthorProfile() {
  var d = state.detail;
  if (d) { closeModal('modal-detail'); go('profile', { id: d.user_id }); }
}
function goNeedAuthor() {
  var n = state.need;
  if (n) goUser(n.user_id);
}
function goUser(id) {
  if (!id) return;
  closeModal('modal-detail'); closeModal('modal-need');
  go('profile', { id: id });
}

/* ---------- Upload ---------- */
function openUploadMenu() { openModal('modal-upload-menu'); }
function openAssetUpload() { closeModal('modal-upload-menu'); openModal('modal-upload'); }
function openCommentUpload() { closeModal('modal-upload-menu'); openModal('modal-upload-comment'); }
function openNeedPost() { if (!requireSignIn()) return; closeModal('modal-upload-menu'); openModal('modal-need-post'); }

function pickFile(input) {
  state.assetFile = input.files && input.files[0] ? input.files[0] : null;
  var n = state.assetFile ? state.assetFile.name : '';
  document.getElementById('asset-file-name').textContent = n ? 'Selected: ' + n : '';
}

async function publishAsset() {
  var name = document.getElementById('asset-name').value.trim();
  var desc = document.getElementById('asset-desc').value.trim();
  if (!name) { toast('Please enter a name'); return; }
  var sec = state.needReply ? state.needReply.section : document.getElementById('asset-sec').value;
  var data;
  if (state.assetFile) {
    var fd = new FormData();
    fd.append('type', 'asset');
    fd.append('title', name);
    fd.append('desc', desc);
    fd.append('section', sec);
    if (state.needReply) fd.append('need_id', state.needReply.id);
    fd.append('file', state.assetFile);
    data = await uploadForm('/api/items', fd);
  } else {
    var body = { type: 'asset', title: name, desc: desc, section: sec };
    if (state.needReply) body.need_id = state.needReply.id;
    data = await api('/api/items', 'POST', body);
  }
  if (data.error) { toast(data.error); return; }
  var wasReply = !!state.needReply;
  state.needReply = null;
  state.assetFile = null;
  closeModal('modal-upload');
  document.getElementById('asset-name').value = '';
  document.getElementById('asset-desc').value = '';
  document.getElementById('asset-file-name').textContent = '';
  document.getElementById('asset-file').value = '';
  toast(wasReply ? 'Posted to the needs hub' : 'Published: ' + secName(sec) + '/' + name);
}

async function publishComment() {
  var v = document.getElementById('comment-text').value.trim();
  if (!v) { toast('Content cannot be empty'); return; }
  var sec = state.needReply ? state.needReply.section : document.getElementById('comment-sec').value;
  var body = { type: 'comment', title: v, section: sec };
  if (state.needReply) body.need_id = state.needReply.id;
  var data = await api('/api/items', 'POST', body);
  if (data.error) { toast(data.error); return; }
  var wasReply = !!state.needReply;
  state.needReply = null;
  closeModal('modal-upload-comment');
  document.getElementById('comment-text').value = '';
  toast(wasReply ? 'Posted to the needs hub' : 'Published: ' + secName(sec) + '/' + v.slice(0, 20));
}

/* ---------- Needs ---------- */
async function renderNeeds() {
  var data = await api('/api/needs');
  var list = data.needs || [];
  document.getElementById('needs-list').innerHTML = list.map(function (n) {
    return '<div class="need-card" onclick="openNeed(' + n.id + ')">'
      + '<div class="need-top"><span class="type-tag need">Need</span><span class="need-title">' + esc(n.sec_name) + '/' + esc(n.title) + '</span></div>'
      + '<div class="need-meta"><span>needs count: ' + n.needs + '</span><span class="who-link" onclick="event.stopPropagation();goUser(' + n.user_id + ')">by ' + esc(userName(n.author)) + '</span><span>' + esc(n.time_ago) + '</span></div>'
      + '</div>';
  }).join('') || '<div class="empty">No needs yet, tap + at the top-right to post the first one.</div>';
}

async function openNeed(id) {
  var data = await api('/api/needs/' + id);
  if (data.error) { toast(data.error); return; }
  var n = data.need;
  state.need = n;
  document.getElementById('need-title').textContent = n.sec_name + '/' + n.title;
  document.getElementById('need-letter').textContent = n.author.letter;
  document.getElementById('need-letter').className = 'avatar sm ' + lvClass(n.author.level);
  document.getElementById('need-author').textContent = userName(n.author);
  document.getElementById('need-count').textContent = n.needs;
  var replies = n.replies || [];
  document.getElementById('need-replies').innerHTML = replies.map(contentRow).join('')
    || '<div class="empty" style="padding:20px 0">No replies yet, come help them~</div>';
  openModal('modal-need');
}

async function needAlso() {
  var n = state.need; if (!n) return;
  var data = await api('/api/needs/' + n.id + '/need-also', 'POST');
  if (data.error) { toast(data.error); return; }
  document.getElementById('need-count').textContent = data.needs;
  toast(data.message || ('Added, current needs count: ' + data.needs));
}

function replyNeed(type) {
  state.needReply = state.need;
  closeModal('modal-need');
  if (type === 'asset') openAssetUpload(); else openCommentUpload();
}

async function publishNeed() {
  var title = document.getElementById('need-title-input').value.trim();
  var sec = document.getElementById('need-sec').value;
  if (!title) { toast('Please enter the resource you need'); return; }
  var data = await api('/api/needs', 'POST', { title: title, section: sec });
  if (data.error) { toast(data.error); return; }
  closeModal('modal-need-post');
  document.getElementById('need-title-input').value = '';
  toast('Published: ' + secName(sec) + '/' + title);
  go('needs');
}

/* ---------- Auth (sign in / sign up / sign out) ---------- */
function openLogin() { openModal('modal-login'); }
function openSignup() { openModal('modal-create'); }

async function signIn() {
  var account = document.getElementById('li-account').value.trim();
  var name = document.getElementById('li-name').value.trim();
  var msg = document.getElementById('li-msg');
  var data = await api('/api/auth/login', 'POST', { account: account, name: name });
  if (data.error) { msg.textContent = data.error; return; }
  afterAuth(data);
}

function alreadyHaveAccount() {
  // "I Already have my account." → enter the site (not signed in), tap Sign in at the top-right to sign in
  document.getElementById('gate').style.display = 'none';
  toast('You are in, tap Sign in at the top-right to sign in');
}

function switchLoginTab(tab) {
  var student = document.getElementById('login-student');
  var alumnus = document.getElementById('login-alumnus');
  var ts = document.getElementById('tab-student');
  var ta = document.getElementById('tab-alumnus');
  if (tab === 'alumnus') {
    student.style.display = 'none';
    alumnus.style.display = 'block';
    ts.classList.remove('active');
    ta.classList.add('active');
  } else {
    student.style.display = 'block';
    alumnus.style.display = 'none';
    ts.classList.add('active');
    ta.classList.remove('active');
  }
}

async function sendCode() {
  var number = document.getElementById('st-number').value.trim();
  if (!number) { document.getElementById('st-msg').textContent = 'Please enter your cell phone number'; return; }
  var data = await api('/api/auth/send-code', 'POST', { number: number });
  if (data.error) { document.getElementById('st-msg').textContent = data.error; return; }
  var el = document.getElementById('st-demo-code');
  el.style.display = 'block';
  el.textContent = 'Verification code (demo): ' + data.code + ' — enter it in the box above';
}

function afterAuth(data) {
  closeModal('modal-login');
  closeModal('modal-create');
  document.getElementById('gate').style.display = 'none';
  signedIn = true;
  meUser = data.user;
  renderSignin();
  toast(data.created ? 'Signed up · ' + meUser.name : 'Signed in · ' + meUser.name);
}

async function studentAuth() {
  var account = document.getElementById('st-account').value.trim();
  var name = document.getElementById('st-name').value.trim();
  var number = document.getElementById('st-number').value.trim();
  var code = document.getElementById('st-code').value.trim();
  var college = document.getElementById('st-college').value;
  var msg = document.getElementById('st-msg');
  var data = await api('/api/auth/student', 'POST', { account: account, name: name, number: number, code: code, college: college });
  if (data.error) { msg.textContent = data.error; return; }
  afterAuth(data);
}

async function alumnusAuth() {
  var account = document.getElementById('al-account').value.trim();
  var name = document.getElementById('al-name').value.trim();
  var invite = document.getElementById('al-code').value.trim();
  var msg = document.getElementById('al-msg');
  var data = await api('/api/auth/alumnus', 'POST', { account: account, name: name, invite: invite });
  if (data.error) { msg.textContent = data.error; return; }
  afterAuth(data);
}

async function signOut() {
  await api('/api/auth/logout', 'POST');
  signedIn = false;
  meUser = null;
  renderSignin();
  navHistory = [];
  render('home');
  toast('Signed out');
}

function renderSignin() {
  document.querySelectorAll('.signin-slot').forEach(function (slot) {
    if (signedIn && meUser) {
      slot.innerHTML = '<button class="upload-btn" onclick="openUploadMenu()" title="Upload">+</button>'
        + '<div class="avatar ' + lvClass(meUser.level) + '" onclick="go(\'profile\',{id:' + meUser.id + '})" title="My profile">' + esc(meUser.letter) + '</div>'
        + '<button class="signout-btn" onclick="signOut()">Sign out</button>';
    } else {
      slot.innerHTML = '<button class="signin-btn" onclick="openLogin()">Sign in</button>';
    }
  });
  var rb = document.getElementById('report-box-btn');
  if (rb) rb.style.display = signedIn ? 'inline-block' : 'none';
}

/* ---------- Info pages ---------- */
var INFO = {
  about: {
    title: 'About PaHub',
    body: '<p>PaHub is a nonprofit learning-resource-sharing platform for college students.</p>'
      + '<p>Here you can get learning resources for free, and share your own notes and experience — everyone is a creator.</p>'
      + '<p>This site is completely free and nonprofit.</p>'
  },
  rules: {
    title: 'Community Rules',
    body: '<ul class="info-list">'
      + '<li>Share real, useful content; no spam.</li>'
      + '<li>Respect original authors; credit the source when reposting.</li>'
      + '<li>No irrelevant ads, no illegal content.</li>'
      + '<li>Only comments, no private messages.</li>'
      + '<li>Report violations via "Report Infringement".</li>'
      + '</ul>'
  },
  privacy: {
    title: 'Privacy Policy',
    body: '<p>We only collect the info you enter yourself (name, student ID, college, cell phone number) for sign-up and sign-in.</p>'
      + '<p>Your info will not be sold or leaked to third parties.</p>'
  },
  report: {
    title: 'Report Infringement',
    body: '<p>If content infringes your rights or violates the rules, report it via comments or contact an admin.</p>'
      + '<p>We will review and handle it as soon as possible.</p>'
  }
};

function openInfo(key) {
  var info = INFO[key];
  if (!info) return;
  document.getElementById('info-title').textContent = info.title;
  document.getElementById('info-body').innerHTML = info.body;
  openModal('modal-info');
}

/* ---------- Report ---------- */
function openReportBox() { openModal('modal-report-box'); }
function openReportLetter() { closeModal('modal-report-box'); openModal('modal-report-letter'); }
function pickReportFile(input) {
  state.reportFile = input.files && input.files[0] ? input.files[0] : null;
  var n = state.reportFile ? state.reportFile.name : '';
  document.getElementById('report-file-name').textContent = n ? 'Selected: ' + n : '';
}
async function submitReport() {
  var text = document.getElementById('report-text').value.trim();
  if (!text) { toast('Please enter your report text'); return; }
  var fd = new FormData();
  fd.append('text', text);
  if (state.reportFile) fd.append('file', state.reportFile);
  var data = await uploadForm('/api/reports', fd);
  if (data.error) { toast(data.error); return; }
  closeModal('modal-report-letter');
  document.getElementById('report-text').value = '';
  document.getElementById('report-file-name').textContent = '';
  document.getElementById('report-file').value = '';
  state.reportFile = null;
  toast('Report submitted, visible to admins only');
}

/* ---------- Close autocomplete on outside click ---------- */
document.addEventListener('click', function (e) {
  if (!e.target.closest('.home-search')) {
    var box = document.getElementById('home-suggest');
    if (box) box.classList.remove('show');
  }
});

/* ---------- Startup ---------- */
(async function init() {
  var s = await api('/api/sections');
  if (s.sections) SECTIONS = s.sections;

  var m = await api('/api/me');
  if (m.user) {
    signedIn = true;
    meUser = m.user;
    document.getElementById('gate').style.display = 'none';
  } else {
    document.getElementById('gate').style.display = 'flex';
  }

  render('home');
  renderSignin();
})();

window.onerror = function (msg, src, line) {
  var b = document.getElementById('err-banner');
  if (b) { b.style.display = 'block'; b.textContent = 'Script error: ' + msg + ' (line ' + line + ')'; }
};
