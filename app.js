import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, getDocs, getDoc, addDoc, onSnapshot, query, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB1eP2u9-9ydGDzCe7HEVOtHkgld6_Bm9A",
  authDomain: "my-new-project-a510e.firebaseapp.com",
  projectId: "my-new-project-a510e",
  storageBucket: "my-new-project-a510e.firebasestorage.app",
  messagingSenderId: "589824399304",
  appId: "1:589824399304:web:9e93181ccc258c316b52fd",
  measurementId: "G-88XV4T1K3B"
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();

let currentUser = null;

/* ---------- local (guest) persistence ---------- */
const LS_SESSIONS = 'st_sessions';
const LS_PREFS = 'st_prefs';
const LS_TIMERSTATE = 'st_timerstate';

function localGet(key, fallback){
  try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }catch(e){ return fallback; }
}
function localSet(key, val){
  try{
    localStorage.setItem(key, JSON.stringify(val));
  }catch(e){}
}
function sanitizeHTML(str) { return str.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const DEFAULT_SUBJECTS = [
  { name: 'Bengali', isCore: true, sub: ['Text', 'Grammar'] },
  { name: 'English', isCore: true, sub: ['Text', 'Grammar'] },
  { name: 'Math', isCore: true },
  { name: 'Life Science', isCore: true },
  { name: 'Physical Science', isCore: true },
  { name: 'History', isCore: true },
  { name: 'Geography', isCore: true }
];
const DEFAULT_WORK_TYPES = ['Revision', 'New Topic', 'Memorize', 'Reading', 'Practice', 'Notes', 'Mock Test', 'Other'];

let sessions = [];               // {id, date, subject, workType, minutes, ts}
let nonStudySessions = [];       // {id, date, subject, workType, minutes, ts}
let prefs = { dailyTarget: 120, subjects: [], workTypes: [] };

let unsubSessions = null;

let unsubNonStudySessions = null;

/* ---------- data layer: switches between local + firestore ---------- */
async function loadAll(){
  if(currentUser){
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const q = query(collection(db,'users',currentUser.uid,'sessions'), where('ts', '>=', thirtyDaysAgo));
    
    if (unsubSessions) unsubSessions();
    unsubSessions = onSnapshot(q, (snap) => {
      sessions = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      refreshEverything();
    });

    const qNS = query(collection(db,'users',currentUser.uid,'nonStudySessions'), where('ts', '>=', thirtyDaysAgo));
    if (unsubNonStudySessions) unsubNonStudySessions();
    unsubNonStudySessions = onSnapshot(qNS, (snap) => {
      nonStudySessions = snap.docs.map(d => ({ id:d.id, ...d.data(), isNonStudy: true }));
      refreshEverything();
    });

    const prefSnap = await getDoc(doc(db,'users',currentUser.uid,'meta','prefs'));
    prefs = prefSnap.exists() ? prefSnap.data() : { dailyTarget:120, subjects: [...DEFAULT_SUBJECTS], workTypes: [...DEFAULT_WORK_TYPES] };
  } else {
    sessions = localGet(LS_SESSIONS, []);
    nonStudySessions = localGet('st_nonstudy_sessions', []).map(s => ({ ...s, isNonStudy: true }));
    prefs = localGet(LS_PREFS, { dailyTarget:120, subjects: [...DEFAULT_SUBJECTS], workTypes: [...DEFAULT_WORK_TYPES] });
  }

  // Data migration for subjects & workTypes
  const oldBengaliCore = ['বাংলা', 'ইংরেজি', 'অংক', 'জীবন বিজ্ঞান', 'ভৌত বিজ্ঞান', 'ইতিহাস', 'ভূগোল'];
  if(prefs.subjects && prefs.subjects.length > 0){
    prefs.subjects = prefs.subjects.filter(s => !oldBengaliCore.includes(typeof s === 'string' ? s : s.name));
  }
  
  if(!prefs.subjects || prefs.subjects.length === 0) {
    prefs.subjects = DEFAULT_SUBJECTS.map(s => ({...s}));
  } else {
    // Add missing English core subjects
    DEFAULT_SUBJECTS.forEach(cs => {
      if(!prefs.subjects.find(s => (s.name || s) === cs.name)){
        prefs.subjects.unshift({...cs});
      }
    });
    prefs.subjects = prefs.subjects.map(s => {
      if (typeof s === 'string') {
        const coreMatch = DEFAULT_SUBJECTS.find(d => d.name === s);
        if (coreMatch) return { ...coreMatch };
        return { name: s, isCore: false };
      }
      return s;
    });
  }
  
  const oldBengaliWT = ['রিভিশন', 'নতুন পড়া', 'মুখস্থ করা', 'রিডিং পড়া', 'প্রশ্ন উত্তর প্র্যাকটিস', 'নোট তৈরি', 'অন্যান্য'];
  if(prefs.workTypes && prefs.workTypes.length > 0){
    prefs.workTypes = prefs.workTypes.filter(wt => !oldBengaliWT.includes(wt));
    DEFAULT_WORK_TYPES.forEach(dwt => {
      if(!prefs.workTypes.includes(dwt)){
        prefs.workTypes.unshift(dwt);
      }
    });
  }
  
  if(!prefs.workTypes || prefs.workTypes.length === 0) {
    prefs.workTypes = [...DEFAULT_WORK_TYPES];
  }
}
async function addSession(subjName, minutes, workType){
  if(minutes <= 0) return;
  const subjObj = prefs.subjects.find(s => (s.name || s) === selectedSubject);
  const isNS = subjObj ? !!subjObj.isNonStudy : false;

  const rec = { date: todayStr(), subject: subjName, workType: workType || 'N/A', minutes, ts: Date.now() };
  
  if(isNS) {
    rec.isNonStudy = true;
    if (currentUser) {
      try {
        await addDoc(collection(db, 'users', currentUser.uid, 'nonStudySessions'), rec);
      } catch(e) {
        console.error(e);
        showToast('ইন্টারনেট কানেকশন নেই! নন-স্টাডি সেশন অফলাইনে সেভ করা হয়েছে।');
        rec.id = 'ns' + Date.now();
        nonStudySessions.push(rec);
        localSet('st_nonstudy_sessions', nonStudySessions);
      }
    } else {
      rec.id = 'ns' + Date.now();
      nonStudySessions.push(rec);
      localSet('st_nonstudy_sessions', nonStudySessions);
    }
  } else {
    if(currentUser){
      try {
        await addDoc(collection(db,'users',currentUser.uid,'sessions'), rec);
      } catch(e) {
        console.error(e);
        showToast('ইন্টারনেট কানেকশন নেই! সেশন অফলাইনে সেভ করা হয়েছে।');
        rec.id = 'l' + Date.now();
        sessions.push(rec);
        localSet(LS_SESSIONS, sessions);
      }
    } else {
      rec.id = 'l' + Date.now();
      sessions.push(rec);
      localSet(LS_SESSIONS, sessions);
    }
  }
}
async function deleteSession(id){
  const isNS = nonStudySessions.some(s => s.id === id);
  if(isNS) {
    nonStudySessions = nonStudySessions.filter(s => s.id !== id);
    if (currentUser) {
      try {
        await deleteDoc(doc(db, 'users', currentUser.uid, 'nonStudySessions', id));
      } catch(e) {
        console.error(e);
        showToast('ইন্টারনেট কানেকশন নেই! অফলাইনে ডিলিট করা হয়েছে।');
        localSet('st_nonstudy_sessions', nonStudySessions);
      }
    } else {
      localSet('st_nonstudy_sessions', nonStudySessions);
    }
  } else {
    sessions = sessions.filter(s => s.id !== id);
    if(currentUser){
      try {
        await deleteDoc(doc(db,'users',currentUser.uid,'sessions',id));
      } catch(e) {
        console.error(e);
        showToast('ইন্টারনেট কানেকশন নেই! অফলাইনে ডিলিট করা হয়েছে।');
        localSet(LS_SESSIONS, sessions);
      }
    } else {
      localSet(LS_SESSIONS, sessions);
    }
  }
}
async function savePrefs(){
  if(currentUser){
    try {
      await setDoc(doc(db,'users',currentUser.uid,'meta','prefs'), prefs);
    } catch(e) {
      console.error(e);
      showToast('ইন্টারনেট কানেকশন নেই! সেটিং অফলাইনে সেভ করা হয়েছে।');
      localSet(LS_PREFS, prefs);
    }
  } else {
    localSet(LS_PREFS, prefs);
  }
}

/* ---------- auth ---------- */
const authbar = document.getElementById('authbar');
const cloudnote = document.getElementById('cloudnote');

document.getElementById('googleBtn').addEventListener('click', async ()=>{
  try{
    await signInWithPopup(auth, provider);
  }catch(e){
    showToast('সাইন ইন ব্যর্থ হয়েছে — Firebase কনসোলে ডোমেইন যোগ করা আছে কিনা দেখুন');
  }
});

onAuthStateChanged(auth, async (user)=>{
  currentUser = user;
  renderAuthBar();
  
  if (currentUser) {
    // Seamless Auth Merge
    const localSess = localGet(LS_SESSIONS, []);
    const localNS = localGet('st_nonstudy_sessions', []);
    const localP = localGet(LS_PREFS, null);
    
    const snap = await getDocs(collection(db,'users',currentUser.uid,'sessions'));
    const fbSess = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    
    if (localSess.length > 0) {
      for (const s of localSess) {
        const exists = fbSess.find(fs => fs.ts === s.ts);
        if(!exists) {
          const rec = { date: s.date, subject: s.subject, minutes: s.minutes, ts: s.ts, workType: s.workType || 'অন্যান্য' };
          await addDoc(collection(db,'users',currentUser.uid,'sessions'), rec);
        }
      }
      localStorage.removeItem(LS_SESSIONS);
    }

    const snapNS = await getDocs(collection(db,'users',currentUser.uid,'nonStudySessions'));
    const fbNS = snapNS.docs.map(d => ({ id:d.id, ...d.data(), isNonStudy: true }));
    
    if (localNS.length > 0) {
      for (const s of localNS) {
        const exists = fbNS.find(fs => fs.ts === s.ts);
        if(!exists) {
          const rec = { date: s.date, subject: s.subject, minutes: s.minutes, ts: s.ts, workType: s.workType || 'Other' };
          await addDoc(collection(db,'users',currentUser.uid,'nonStudySessions'), rec);
        }
      }
      localStorage.removeItem('st_nonstudy_sessions');
    }
    
    const prefSnap = await getDoc(doc(db,'users',currentUser.uid,'meta','prefs'));
    let fbPrefs = prefSnap.exists() ? prefSnap.data() : { dailyTarget:120, subjects: DEFAULT_SUBJECTS.map(s=>({...s})), workTypes: [...DEFAULT_WORK_TYPES] };
    
    if (localP) {
      if(localP.subjects) {
        const currentNames = fbPrefs.subjects.map(s => typeof s === 'string' ? s : s.name);
        localP.subjects.forEach(ls => {
          const name = typeof ls === 'string' ? ls : ls.name;
          if (!currentNames.includes(name)) {
            const coreMatch = DEFAULT_SUBJECTS.find(d => d.name === name);
            if (coreMatch) fbPrefs.subjects.push({ ...coreMatch });
            else fbPrefs.subjects.push(typeof ls === 'string' ? { name: ls, isCore: false } : ls);
            currentNames.push(name);
          }
        });
      }
      if(localP.workTypes) {
        localP.workTypes.forEach(w => {
          if(!fbPrefs.workTypes.includes(w)) fbPrefs.workTypes.push(w);
        });
      }
      fbPrefs.dailyTarget = localP.dailyTarget || fbPrefs.dailyTarget;
      localStorage.removeItem(LS_PREFS);
    }
    await setDoc(doc(db,'users',currentUser.uid,'meta','prefs'), fbPrefs);
  } else {
    if (unsubSessions) { unsubSessions(); unsubSessions = null; }
    if (unsubNonStudySessions) { unsubNonStudySessions(); unsubNonStudySessions = null; }
  }
  
  await loadAll();
  
  if(selectedSubject !== '' && !prefs.subjects.find(s => s.name === selectedSubject)) {
    selectedSubject = prefs.subjects[0]?.name || '';
  }
  if(selectedWorkType !== '' && !prefs.workTypes.includes(selectedWorkType)) {
    selectedWorkType = prefs.workTypes[0] || '';
  }
  
  renderSelectionChips();
  initTimerFromLocalState();
  await refreshEverything();
});

function renderAuthBar(){
  if(currentUser){
    authbar.innerHTML = `
      <div class="userchip">
        <img src="${currentUser.photoURL || ''}" onerror="this.style.display='none'">
        <span>${currentUser.displayName || currentUser.email || 'ব্যবহারকারী'}</span>
      </div>
      <button class="signout" id="signOutBtn">সাইন আউট</button>`;
    document.getElementById('signOutBtn').addEventListener('click', ()=> signOut(auth));
    cloudnote.textContent = 'আপনার ডেটা ক্লাউডে সেভ হচ্ছে এবং সব ডিভাইসে সিঙ্ক থাকবে';
  } else {
    authbar.innerHTML = `<button class="gbtn" id="googleBtn2">Google দিয়ে সাইন ইন করুন</button>`;
    document.getElementById('googleBtn2').addEventListener('click', async ()=>{
      try{ await signInWithPopup(auth, provider); }
      catch(e){ showToast('সাইন ইন ব্যর্থ হয়েছে — Firebase কনসোলে ডোমেইন যোগ করা আছে কিনা দেখুন'); }
    });
    cloudnote.textContent = 'সাইন ইন না করলে ডেটা শুধু এই ডিভাইসে থাকবে';
  }
}

/* ---------- date helpers ---------- */
function todayStr(d=new Date()){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function daysAgoStr(n){ const d=new Date(); d.setDate(d.getDate()-n); return todayStr(d); }
function formatDateTime(ts){
  if(!ts) return '';
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; h = h ? h : 12;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${h}:${m} ${ampm}, ${dd}-${mm}-${yyyy}`;
}
function formatTimeOnly(ts) {
  if(!ts) return '';
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; h = h ? h : 12;
  return `${h}:${m} ${ampm}`;
}
function formatDateOnly(ts) {
  if(!ts) return '';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}
function formatTimeRange(endTs, minutes) {
  if (!endTs) return '';
  const startTs = endTs - (minutes * 60 * 1000);
  const startStr = formatTimeOnly(startTs);
  const endStr = formatTimeOnly(endTs);
  const dateStr = formatDateOnly(endTs);
  return `${startStr} - ${endStr}, ${dateStr}`;
}
function formatTimeRangeOnlyTime(endTs, minutes) {
  if (!endTs) return '';
  const startTs = endTs - (minutes * 60 * 1000);
  const startStr = formatTimeOnly(startTs);
  const endStr = formatTimeOnly(endTs);
  return `${startStr} - ${endStr}`;
}
const bnDayShort = ['রবি','সোম','মঙ্গ','বুধ','বৃহ','শুক্র','শনি'];

/* ---------- audio + vibration + notify ---------- */
let audioCtx;
let isMuted = false;
const muteBtn = document.getElementById('muteBtn');
muteBtn.addEventListener('click', (e)=>{
  isMuted = !isMuted;
  muteBtn.textContent = isMuted ? '🔇' : '🔊';
  muteBtn.className = 'audio-btn ' + (isMuted ? 'muted' : '');
});

function playChime(){
  if(isMuted) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [523.25, 659.25, 783.99, 1046.50].forEach((freq,i)=>{
      const osc = audioCtx.createOscillator(); 
      const gain = audioCtx.createGain();
      osc.type='sine'; 
      osc.frequency.value=freq;
      gain.gain.setValueAtTime(0.0001, now+i*0.1);
      gain.gain.exponentialRampToValueAtTime(0.2, now+i*0.1+0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now+i*0.1+0.8);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now+i*0.1); 
      osc.stop(now+i*0.1+0.85);
    });
  }catch(e){}
}
function vibrate(){ if(navigator.vibrate) navigator.vibrate([250,120,250,120,250]); }
function notify(msg){
  if('Notification' in window && Notification.permission==='granted'){
    try{ new Notification('সময় শেষ! ⏰', { body: msg }); }catch(e){}
  }
}
if('Notification' in window && Notification.permission==='default'){
  document.addEventListener('click', function reqPerm(){ Notification.requestPermission(); document.removeEventListener('click', reqPerm); }, { once:true });
}
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=> t.classList.remove('show'), 3500);
}

/* ---------- subjects & work type UI ---------- */
let selectedSubject = '';
let selectedSubMenu = '';
let selectedWorkType = '';
let isTimerActive = false;
let isEditMode = false;

document.getElementById('editModeToggle').addEventListener('click', () => {
  isEditMode = !isEditMode;
  renderSelectionChips();
});

function renderSelectionChips(){
  const area1 = document.getElementById('subjSelectChips');
  const area2 = document.getElementById('subMenuChips');
  const area3 = document.getElementById('workTypeChips');
  
  if(isTimerActive){
    document.getElementById('subjectSelectionArea').classList.add('locked-chips');
    document.getElementById('workTypeSelectionArea').classList.add('locked-chips');
  } else {
    document.getElementById('subjectSelectionArea').classList.remove('locked-chips');
    document.getElementById('workTypeSelectionArea').classList.remove('locked-chips');
  }

  area1.innerHTML = prefs.subjects.map(s => {
    const isC = s.isCore ? 'core-chip' : '';
    const isA = (s.name === selectedSubject) ? 'active' : '';
    let visualClass = '';
    if(isTimerActive) visualClass = isA ? 'timer-glow' : 'inactive-dim';
    return `<div class="sel-chip ${isC} ${isA} ${visualClass}" data-name="${s.name}">${s.name}</div>`;
  }).join('') + (!isTimerActive && isEditMode ? `<div class="sel-chip add-chip" data-action="add-subject" style="border:1px dashed var(--accent); color:var(--accent); background:transparent;">＋ Subject</div>` : '');

  const subjObj = prefs.subjects.find(s => s.name === selectedSubject);
  if(subjObj && ((subjObj.sub && subjObj.sub.length > 0) || !isTimerActive)) {
    area2.style.display = 'flex';
    if(subjObj.sub && subjObj.sub.length > 0) {
      if(!selectedSubMenu || !subjObj.sub.includes(selectedSubMenu)) selectedSubMenu = subjObj.sub[0];
      area2.innerHTML = subjObj.sub.map(sub => {
        const isA = (sub === selectedSubMenu) ? 'active' : '';
        let visualClass = '';
        if(isTimerActive) visualClass = isA ? 'timer-glow' : 'inactive-dim';
        return `<div class="sel-chip ${isA} ${visualClass}" data-sub="${sub}">↳ ${sub}</div>`;
      }).join('') + (!isTimerActive && isEditMode ? `<div class="sel-chip add-chip" data-action="add-sub" style="border:1px dashed var(--accent); color:var(--accent); background:transparent;">＋ Sub-Subject</div>` : '');
    } else {
      selectedSubMenu = '';
      area2.innerHTML = (!isTimerActive && isEditMode ? `<div class="sel-chip add-chip" data-action="add-sub" style="border:1px dashed var(--accent); color:var(--accent); background:transparent;">＋ Sub-Subject</div>` : '');
    }
  } else {
    area2.style.display = 'none';
    selectedSubMenu = '';
  }

  area3.innerHTML = prefs.workTypes.map(w => {
    const isA = (w === selectedWorkType) ? 'active' : '';
    let visualClass = '';
    if(isTimerActive) visualClass = isA ? 'timer-glow' : 'inactive-dim';
    return `<div class="sel-chip ${isA} ${visualClass}" data-w="${w}">${w}</div>`;
  }).join('') + (!isTimerActive && isEditMode ? `<div class="sel-chip add-chip" data-action="add-worktype" style="border:1px dashed var(--accent); color:var(--accent); background:transparent;">＋ Work Type</div>` : '');
}

/* ---------- Chip Event Delegation ---------- */
function handleChipInteraction(e, type) {
  if (isTimerActive) return;
  const chip = e.target.closest('.sel-chip');
  if (!chip) return;
  
  if (e.type === 'click') {
    const action = chip.dataset.action;
    if (action) {
      if(action === 'add-subject') openAddModal('subject');
      if(action === 'add-sub') openAddModal('sub');
      if(action === 'add-worktype') openAddModal('workType');
      return;
    }
    if (type === 'subject') { 
      selectedSubject = (selectedSubject === chip.dataset.name) ? '' : chip.dataset.name; 
      selectedSubMenu = ''; 
    }
    if (type === 'sub') { 
      selectedSubMenu = (selectedSubMenu === chip.dataset.sub) ? '' : chip.dataset.sub; 
    }
    if (type === 'workType') { 
      selectedWorkType = (selectedWorkType === chip.dataset.w) ? '' : chip.dataset.w; 
    }
    renderSelectionChips();
  } else if (e.type === 'dblclick' || e.type === 'longpress' || e.type === 'contextmenu') {
    if (chip.classList.contains('add-chip')) return;
    e.preventDefault();
    if (type === 'subject') openEditModal('subject', chip.dataset.name);
    if (type === 'sub') openEditModal('sub', chip.dataset.sub);
    if (type === 'workType') openEditModal('workType', chip.dataset.w);
  }
}

let pressTimer = null;
const setupDelegation = (areaId, type) => {
  const el = document.getElementById(areaId);
  if (!el) return;
  el.addEventListener('click', (e) => handleChipInteraction(e, type));
  el.addEventListener('dblclick', (e) => handleChipInteraction(e, type));
  el.addEventListener('contextmenu', (e) => handleChipInteraction(e, type));
  el.addEventListener('touchstart', (e) => {
    if(isTimerActive) return;
    const chip = e.target.closest('.sel-chip');
    if (!chip) return;
    pressTimer = setTimeout(() => {
      const pseudoEvent = { type: 'longpress', target: chip, preventDefault: () => {} };
      handleChipInteraction(pseudoEvent, type);
    }, 600);
  });
  el.addEventListener('touchend', () => clearTimeout(pressTimer));
  el.addEventListener('touchmove', () => clearTimeout(pressTimer));
};
setupDelegation('subjSelectChips', 'subject');
setupDelegation('subMenuChips', 'sub');
setupDelegation('workTypeChips', 'workType');

/* ---------- Chip Management UI & Modal ---------- */
const editModal = document.getElementById('editModal');
const modalInput = document.getElementById('modalInput');
const modalTitle = document.getElementById('modalTitle');
let editContext = { type: null, oldName: null }; // type: 'subject' | 'workType'

function openEditModal(type, name) {
  editContext = { type, oldName: name };
  if(type === 'subject') modalTitle.textContent = 'বিষয় সম্পাদনা';
  else if(type === 'sub') modalTitle.textContent = 'সাব-সাবজেক্ট সম্পাদনা';
  else modalTitle.textContent = 'কাজের ধরন সম্পাদনা';
  modalInput.value = name;
  editModal.classList.add('show');
}

function closeEditModal() {
  editModal.classList.remove('show');
  editContext = { type: null, oldName: null };
}

document.getElementById('modalCancel').addEventListener('click', closeEditModal);

document.getElementById('modalDelete').addEventListener('click', async () => {
  const { type, oldName } = editContext;
  
  if (type === 'subject') {
    const subj = prefs.subjects.find(s => s.name === oldName);
    if (prefs.subjects.length <= 1) { showToast('অন্তত একটি বিষয় থাকতে হবে'); return; }
    if (subj && subj.isCore) {
      if (!confirm('আপনি কি নিশ্চিত যে এই কোর সাবজেক্টটি মুছে ফেলতে চান?')) return;
    }
    prefs.subjects = prefs.subjects.filter(s => s.name !== oldName);
    if (selectedSubject === oldName) selectedSubject = prefs.subjects[0].name;
  } 
  else if (type === 'sub') {
    const subj = prefs.subjects.find(s => s.name === selectedSubject);
    if (subj && subj.sub) {
      if (subj.sub.length <= 1) { showToast('অন্তত একটি সাব-সাবজেক্ট থাকতে হবে'); return; }
      subj.sub = subj.sub.filter(x => x !== oldName);
      if (selectedSubMenu === oldName) selectedSubMenu = subj.sub[0];
    }
  }
  else if (type === 'workType') {
    if (prefs.workTypes.length <= 1) { showToast('অন্তত একটি কাজের ধরন থাকতে হবে'); return; }
    prefs.workTypes = prefs.workTypes.filter(w => w !== oldName);
    if (selectedWorkType === oldName) selectedWorkType = prefs.workTypes[0];
  }
  
  await savePrefs();
  renderSelectionChips();
  closeEditModal();
});

document.getElementById('modalSave').addEventListener('click', async () => {
  const { type, oldName } = editContext;
  const newName = sanitizeHTML(modalInput.value.trim());
  if (!newName || newName === oldName) { closeEditModal(); return; }

  if (type === 'subject') {
    if (prefs.subjects.find(s => s.name === newName)) { showToast('এই নামটি আগেই আছে'); return; }
    const subj = prefs.subjects.find(s => s.name === oldName);
    if (subj && subj.isCore) {
      if (!confirm('আপনি কি নিশ্চিত যে এই কোর সাবজেক্টটি পরিবর্তন করতে চান?')) return;
    }
    subj.name = newName;
    if (selectedSubject === oldName) selectedSubject = newName;
  } 
  else if (type === 'sub') {
    const subj = prefs.subjects.find(s => s.name === selectedSubject);
    if (subj && subj.sub) {
      if (subj.sub.includes(newName)) { showToast('এই নামটি আগেই আছে'); return; }
      const idx = subj.sub.indexOf(oldName);
      if (idx !== -1) subj.sub[idx] = newName;
      if (selectedSubMenu === oldName) selectedSubMenu = newName;
    }
  }
  else if (type === 'workType') {
    if (prefs.workTypes.includes(newName)) { showToast('এই নামটি আগেই আছে'); return; }
    const idx = prefs.workTypes.indexOf(oldName);
    if (idx !== -1) prefs.workTypes[idx] = newName;
    if (selectedWorkType === oldName) selectedWorkType = newName;
  }

  await savePrefs();
  renderSelectionChips();
  closeEditModal();
});

/* ---------- Add Modal Logic ---------- */
const addModal = document.getElementById('addModal');
const addModalTitle = document.getElementById('addModalTitle');
const addModalInput = document.getElementById('addModalInput');
const addModalOptions = document.getElementById('addModalOptions');
const modalIsCoreCheck = document.getElementById('modalIsCoreCheck');
const modalIsNonStudyCheck = document.getElementById('modalIsNonStudyCheck');

let addContextType = null;

function openAddModal(type) {
  addContextType = type;
  addModalInput.value = '';
  modalIsCoreCheck.checked = false;
  modalIsNonStudyCheck.checked = false;
  
  if (type === 'subject') {
    addModalTitle.textContent = 'নতুন বিষয় যোগ করুন';
    addModalOptions.style.display = 'block';
  } else if (type === 'sub') {
    addModalTitle.textContent = 'নতুন সাব-সাবজেক্ট যোগ করুন';
    addModalOptions.style.display = 'none';
  } else if (type === 'workType') {
    addModalTitle.textContent = 'নতুন কাজের ধরন যোগ করুন';
    addModalOptions.style.display = 'none';
  }
  
  addModal.classList.add('show');
  setTimeout(() => addModalInput.focus(), 100);
}

function closeAddModal() {
  addModal.classList.remove('show');
}

document.getElementById('addModalCancel').addEventListener('click', closeAddModal);

document.getElementById('addModalSave').addEventListener('click', async () => {
  const val = sanitizeHTML(addModalInput.value.trim());
  if (!val) return;
  
  if (addContextType === 'subject') {
    if(prefs.subjects.find(s => s.name === val)){ showToast('এই বিষয় আগেই আছে'); return; }
    prefs.subjects.push({ name: val, isCore: modalIsCoreCheck.checked, isNonStudy: modalIsNonStudyCheck.checked }); 
    selectedSubject = val;
  } else if (addContextType === 'sub') {
    if(!selectedSubject) { showToast('আগে একটি বিষয় নির্বাচন করুন'); return; }
    const subjObj = prefs.subjects.find(s => s.name === selectedSubject);
    if(subjObj) {
      if(!subjObj.sub) subjObj.sub = [];
      if(subjObj.sub.includes(val)) { showToast('এই সাব-সাবজেক্ট আগেই আছে!'); return; }
      subjObj.sub.push(val);
      selectedSubMenu = val;
    }
  } else if (addContextType === 'workType') {
    if(prefs.workTypes.includes(val)){ showToast('এই কাজের ধরন আগেই আছে'); return; }
    prefs.workTypes.push(val); 
    selectedWorkType = val;
  }
  
  await savePrefs(); 
  renderSelectionChips();
  closeAddModal();
});

/* ---------- pomodoro ---------- */
const pomoToggle = document.getElementById('pomoToggle');
const customTimeRow = document.getElementById('customTimeRow');
const phaseBadge = document.getElementById('phaseBadge');
let pomodoroMode = false;
let pomoPhase = 'work';
const WORK_MIN = 25, BREAK_MIN = 5;

pomoToggle.addEventListener('change', ()=>{
  pomodoroMode = pomoToggle.checked;
  customTimeRow.style.display = pomodoroMode ? 'none' : 'flex';
  phaseBadge.style.display = pomodoroMode ? 'block' : 'none';
  pomoPhase = 'work';
  updatePhaseBadge();
});
function updatePhaseBadge(){
  phaseBadge.textContent = pomoPhase === 'work' ? '⏳ ফোকাস সেশন (25 মিনিট)' : '☕ বিরতি (5 মিনিট)';
}

/* ---------- timer core ---------- */
const hoursEl = document.getElementById('hours');
const minutesEl = document.getElementById('minutes');
const displayEl = document.getElementById('display');
const hintEl = document.getElementById('hint');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');

let totalSeconds=0, endTime=null, remaining=0, running=false;
let tickHandle=null;
let stopwatchMode=false, startAt=null;

function fmt(sec){
  sec = Math.max(0, sec);
  const h=String(Math.floor(sec/3600)).padStart(2,'0');
  const m=String(Math.floor((sec%3600)/60)).padStart(2,'0');
  const s=String(Math.floor(sec%60)).padStart(2,'0');
  const ms=String(Math.floor((sec%1)*100)).padStart(2,'0');
  return h+':'+m+':'+s+'.'+ms;
}
function render(){
  let secLeft;
  if(stopwatchMode){
    secLeft = running ? (Date.now()-startAt)/1000 : remaining;
  } else {
    secLeft = running ? Math.max(0,(endTime-Date.now())/1000) : remaining;
  }
  displayEl.textContent = fmt(secLeft);
  startBtn.disabled = running; pauseBtn.disabled = !running;
}
function tick(){
  if(!running) return;
  if(stopwatchMode){ render(); return; }
  const secLeft = (endTime-Date.now())/1000;
  if(secLeft<=0){ finish(); return; }
  render();
}
async function finish(){
  running=false; remaining=0; displayEl.textContent='00:00:00.00';
  clearInterval(tickHandle);
  
  isTimerActive = false;
  renderSelectionChips();
  
  // Remove glowing timer class
  displayEl.classList.remove('glowing-timer-active');

  const sname = selectedSubMenu ? `${selectedSubject} - ${selectedSubMenu}` : selectedSubject;

  if(pomodoroMode){
    if(pomoPhase==='work'){
      playChime(); vibrate(); notify('ফোকাস সেশন শেষ — এবার বিরতি নিন');
      showToast('⏳ ফোকাস সেশন শেষ! এখন 5 মিনিট বিরতি');
      await addSession(sname, WORK_MIN, selectedWorkType);
      pomoPhase='break';
    } else {
      playChime(); vibrate(); notify('বিরতি শেষ — আবার ফোকাসে ফিরুন');
      showToast('☕ বিরতি শেষ! আবার শুরু করুন');
      pomoPhase='work';
    }
    updatePhaseBadge();
    hintEl.textContent = pomoPhase==='work' ? 'পরের সেশন শুরু করতে Start চাপো' : 'বিরতি শুরু করতে Start চাপো';
  } else {
    playChime(); vibrate(); notify(sname + ' পড়ার সময় শেষ হয়েছে');
    showToast('⏰ ' + sname + ' — সময় শেষ হয়েছে!');
    await addSession(sname, Math.floor(totalSeconds/60), selectedWorkType);
    hintEl.textContent = 'সময় শেষ! আবার শুরু করতে Start চাপো';
  }
  startBtn.disabled=false; pauseBtn.disabled=true;
  hoursEl.disabled=false; minutesEl.disabled=false;
  localStorage.removeItem(LS_TIMERSTATE);
  await refreshEverything();
}
function startTimer(fromResume=false){
  if(!selectedSubject) {
    showToast('আগে একটি বিষয় নির্বাচন করুন');
    return;
  }
  if(!fromResume){
    if(pomodoroMode){
      totalSeconds = (pomoPhase==='work' ? WORK_MIN : BREAK_MIN) * 60;
      stopwatchMode = false;
    } else {
      const h=parseInt(hoursEl.value)||0, m=parseInt(minutesEl.value)||0;
      totalSeconds = h*3600+m*60;
      stopwatchMode = totalSeconds<=0;
    }
    remaining = stopwatchMode ? 0 : totalSeconds;
  }
  running=true;
  if(stopwatchMode){
    startAt = Date.now() - remaining*1000;
  } else {
    endTime = Date.now() + remaining*1000;
  }
  if(pomodoroMode){
    hintEl.textContent = pomoPhase==='work' ? selectedSubject+' পড়া চলছে…' : 'বিরতি চলছে…';
  } else if(stopwatchMode){
    hintEl.textContent = selectedSubject+' — স্টপওয়াচ চলছে… (Reset চাপলে সময় সেভ হবে)';
  } else {
  }
  hoursEl.disabled=true; minutesEl.disabled=true;
  isTimerActive = true; renderSelectionChips();
  
  // Add glowing timer class
  displayEl.classList.add('glowing-timer-active');
  
  render(); clearInterval(tickHandle); tickHandle = setInterval(tick,30);
  
  localSet(LS_TIMERSTATE, { 
    running:true, endTime, totalSeconds, subject: selectedSubject, 
    subMenu: selectedSubMenu, workType: selectedWorkType,
    pomodoroMode, pomoPhase, stopwatchMode, startAt 
  });
}
function pauseTimer(){
  running=false;
  if(stopwatchMode){
    remaining = (Date.now()-startAt)/1000;
  } else {
    remaining = Math.max(0,(endTime-Date.now())/1000);
  }
  hintEl.textContent = stopwatchMode ? 'বিরতিতে আছে — চালিয়ে যেতে Start চাপো (Reset চাপলে সময় সেভ হবে)' : 'বিরতিতে আছে — চালিয়ে যেতে Start চাপো';
  render();
  
  // Remove glowing timer class
  displayEl.classList.remove('glowing-timer-active');
  
  localSet(LS_TIMERSTATE, { 
    running:false, remaining, totalSeconds, subject: selectedSubject, 
    subMenu: selectedSubMenu, workType: selectedWorkType,
    pomodoroMode, pomoPhase, stopwatchMode, startAt, endTime 
  });
}
async function resetTimer(){
  const wasRunning = running;
  const wasStopwatch = stopwatchMode;
  running=false; clearInterval(tickHandle);

  let finalElapsed = 0;
  if(wasStopwatch){
    finalElapsed = wasRunning ? (Date.now()-startAt)/1000 : remaining;
  } else if (totalSeconds > 0) {
    const secLeft = wasRunning ? Math.max(0, (endTime-Date.now())/1000) : remaining;
    finalElapsed = totalSeconds - secLeft;
  }

  if (finalElapsed > 0) {
    const mins = Math.floor(finalElapsed/60);
    if (pomodoroMode && pomoPhase === 'break') {
      showToast('☕ বিরতি বাতিল করা হয়েছে');
    } else if(mins>=1){
      const sname = selectedSubMenu ? `${selectedSubject} - ${selectedSubMenu}` : selectedSubject;
      try {
        await addSession(sname, mins, selectedWorkType);
        showToast(`✅ ${mins} মিনিট সেভ হয়েছে`);
        await refreshEverything();
      } catch(e) {
        showToast('⚠️ সেভ করতে সমস্যা হয়েছে');
      }
    } else {
      showToast('1 মিনিটের কম হওয়ায় সেভ হয়নি');
    }
  }

  remaining=0; totalSeconds=0; endTime=null; startAt=null; stopwatchMode=false;
  displayEl.textContent='00:00:00.00';
  hintEl.textContent='পড়া শুরু করতে Start চাপো';
  hoursEl.disabled=false; minutesEl.disabled=false;
  startBtn.disabled=false; pauseBtn.disabled=true;
  
  isTimerActive = false;
  renderSelectionChips();
  
  pomoPhase='work'; updatePhaseBadge();
  localStorage.removeItem(LS_TIMERSTATE);
}

startBtn.addEventListener('click', ()=> startTimer(isTimerActive));
pauseBtn.addEventListener('click', pauseTimer);
resetBtn.addEventListener('click', resetTimer);

/* ---------- fullscreen auto-hide & toggle ---------- */
const fsContainer = document.getElementById('fsContainer');
const fullscreenBtn = document.getElementById('fullscreenBtn');
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    fsContainer.requestFullscreen().then(() => {
      if(screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(e => console.log('Orientation lock failed:', e));
      }
    }).catch(err => console.log(err));
  } else {
    document.exitFullscreen().then(() => {
      if(screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
    });
  }
});

let fsTimeout;
document.addEventListener('mousemove', () => {
  if (document.fullscreenElement) {
    fsContainer.style.cursor = 'default';
    clearTimeout(fsTimeout);
    fsTimeout = setTimeout(() => {
      fsContainer.style.cursor = 'none';
    }, 3000);
  }
});

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    fsContainer.classList.add('is-fullscreen');
    fullscreenBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';
  } else {
    fsContainer.classList.remove('is-fullscreen');
    fullscreenBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    fsContainer.style.cursor = 'default';
    clearTimeout(fsTimeout);
  }
});

/* ---------- target progress ---------- */
const targetInput = document.getElementById('targetInput');
targetInput.addEventListener('change', async ()=>{
  prefs.dailyTarget = Math.max(10, parseInt(targetInput.value)||120);
  await savePrefs(); renderTarget();
});
function renderTarget(){
  targetInput.value = prefs.dailyTarget;
  const today = todayStr();
  const done = sessions.filter(s=>s.date===today).reduce((a,s)=>a+s.minutes,0);
  const pct = Math.min(100, Math.round(done/prefs.dailyTarget*100));
  document.getElementById('targetFill').style.width = pct+'%';
  document.getElementById('targetDone').textContent = done+' মিনিট';
  document.getElementById('targetPct').textContent = pct+'%';
}

/* ---------- level / xp ---------- */
function renderLevel(){
  const total = sessions.reduce((a,s)=>a+s.minutes,0);
  const XP_PER_LEVEL = 300; 
  const level = Math.floor(total/XP_PER_LEVEL)+1;
  const xp = total % XP_PER_LEVEL;
  document.getElementById('levelNum').textContent = 'Level ' + level;
  document.getElementById('xpMeta').textContent = xp+' / '+XP_PER_LEVEL+' মিনিট';
  document.getElementById('xpFill').style.width = Math.round(xp/XP_PER_LEVEL*100)+'%';
}

/* ---------- week comparison ---------- */
function renderCompare(){
  const thisWeek = sessions.filter(s=> s.date >= daysAgoStr(6)).reduce((a,s)=>a+s.minutes,0);
  const lastWeekDays = new Set(); for(let i=13;i>=7;i--) lastWeekDays.add(daysAgoStr(i));
  const lastWeek = sessions.filter(s=>lastWeekDays.has(s.date)).reduce((a,s)=>a+s.minutes,0);
  const el = document.getElementById('compareLine');
  if(lastWeek===0 && thisWeek===0){ el.textContent=''; return; }
  if(lastWeek===0){ el.innerHTML = 'এই সপ্তাহে <b>'+thisWeek+'</b> মিনিট পড়েছেন'; return; }
  const diff = Math.round((thisWeek-lastWeek)/lastWeek*100);
  const cls = diff>=0 ? 'up' : 'down';
  const arrow = diff>=0 ? '▲' : '▼';
  el.innerHTML = 'গত সপ্তাহের তুলনায় <span class="'+cls+'">'+arrow+' '+Math.abs(diff)+'%</span> '+(diff>=0?'বেশি':'কম');
}

/* ---------- stats tabs ---------- */
let statsMode='daily';
const tabDaily=document.getElementById('tabDaily'), tabWeekly=document.getElementById('tabWeekly');
const chartEl=document.getElementById('chart'), todayTotalEl=document.getElementById('todayTotal');
tabDaily.addEventListener('click', ()=>{ statsMode='daily'; tabDaily.classList.add('active'); tabWeekly.classList.remove('active'); renderStats(); });
tabWeekly.addEventListener('click', ()=>{ statsMode='weekly'; tabWeekly.classList.add('active'); tabDaily.classList.remove('active'); renderStats(); });

function barRow(label,minutes,pct){
  return '<div class="bar-row"><div class="bar-label">'+label+'</div>'
    + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div>'
    + '<div class="bar-value">'+minutes+' মিনিট</div></div>';
}
function renderStats(){
  if(statsMode==='daily'){
    const today = todayStr();
    const todaySessions = sessions.filter(s=>s.date===today);
    const bySubject={}; todaySessions.forEach(s=>{ bySubject[s.subject]=(bySubject[s.subject]||0)+s.minutes; });
    const entries = Object.entries(bySubject).sort((a,b)=>b[1]-a[1]);
    const total = todaySessions.reduce((a,s)=>a+s.minutes,0);
    if(entries.length===0){ chartEl.innerHTML='<div class="empty-note">আজ এখনও কোনো সেশন সম্পন্ন হয়নি</div>'; todayTotalEl.innerHTML=''; return; }
    const max = Math.max(...entries.map(e=>e[1]));
    chartEl.innerHTML = entries.map(([s,m])=>barRow(s,m,Math.max(6,Math.round(m/max*100)))).join('');
    todayTotalEl.innerHTML = 'আজকের মোট সময়: <b>'+total+' মিনিট</b>';
  } else {
    const days=[]; for(let i=6;i>=0;i--) days.push(daysAgoStr(i));
    const totals = days.map(d=>sessions.filter(s=>s.date===d).reduce((a,s)=>a+s.minutes,0));
    const grand = totals.reduce((a,b)=>a+b,0);
    if(grand===0){ chartEl.innerHTML='<div class="empty-note">গত 7 দিনে কোনো সেশন সম্পন্ন হয়নি</div>'; todayTotalEl.innerHTML=''; return; }
    const max = Math.max(...totals,1);
    chartEl.innerHTML = days.map((d,i)=>{
      const parts = d.split('-');
      const dt = new Date(parts[0], parts[1]-1, parts[2]); 
      const label = bnDayShort[dt.getDay()];
      const pct = totals[i]===0?0:Math.max(6,Math.round(totals[i]/max*100));
      return barRow(label, totals[i], pct);
    }).join('');
    todayTotalEl.innerHTML = 'গত 7 দিনের মোট সময়: <b>'+grand+' মিনিট</b>';
  }
}

/* ---------- streak ---------- */
function renderStreak(){
  const uniqueDates = [...new Set(sessions.map(s=>s.date))].sort();
  if(uniqueDates.length===0){ document.getElementById('streakNum').textContent='0'; document.getElementById('streakBest').textContent='0'; return; }
  const dateSet = new Set(uniqueDates);
  let current=0; let cursor=new Date();
  if(!dateSet.has(todayStr(cursor))) cursor.setDate(cursor.getDate()-1);
  while(dateSet.has(todayStr(cursor))){ current++; cursor.setDate(cursor.getDate()-1); }
  let best=1, run=1;
  for(let i=1;i<uniqueDates.length;i++){
    const p1 = uniqueDates[i-1].split('-');
    const p2 = uniqueDates[i].split('-');
    const prev=new Date(p1[0], p1[1]-1, p1[2]), cur=new Date(p2[0], p2[1]-1, p2[2]);
    const diff=Math.round((cur-prev)/86400000);
    run = diff===1 ? run+1 : 1;
    if(run>best) best=run;
  }
  best=Math.max(best,current);
  document.getElementById('streakNum').textContent=current;
  document.getElementById('streakBest').textContent=best;
}

/* ---------- heatmap ---------- */
function renderHeatmap(){
  const grid = document.getElementById('heatmap');
  const totalsByDate = {};
  sessions.forEach(s=> totalsByDate[s.date]=(totalsByDate[s.date]||0)+s.minutes);
  const days = 84; 
  const cells = [];
  for(let i=days-1;i>=0;i--){
    const d = daysAgoStr(i);
    const min = totalsByDate[d]||0;
    let level = 0;
    if(min>0 && min<=30) level=1; else if(min>30 && min<=60) level=2; else if(min>60) level=3;
    cells.push({d, min, level});
  }
  const colors = ['#1c1c1a','#4a3a1a','#7a5f22','#c9962f'];
  grid.innerHTML = cells.map(c=>`<div class="hcell" style="background:${colors[c.level]}" title="${c.d}: ${c.min} মিনিট"></div>`).join('');
}

/* ---------- history ---------- */
function renderHistory(){
  const list = document.getElementById('historyList');
  const allSess = [...sessions, ...nonStudySessions];
  const sorted = allSess.sort((a,b)=> (b.ts||0)-(a.ts||0)).slice(0,30);
  if(sorted.length===0){ list.innerHTML='<div class="empty-note">এখনও কোনো সেশন নেই</div>'; return; }
  list.innerHTML = sorted.map(s=>{
    const isNS = s.isNonStudy || (s.id && String(s.id).startsWith('ns'));
    const badge = isNS ? `<span style="background:var(--line); padding:2px 6px; border-radius:4px; font-size:0.7rem; display:inline-block; width:max-content;">Non-Study</span>` : '';
    return `
    <div class="hist-row">
      <div class="hist-left">
        ${s.subject} ${badge}
        <span class="hist-meta">[${s.workType || 'Other'}] &nbsp; ${s.ts ? formatTimeRange(s.ts, s.minutes) : s.date}</span>
      </div>
      <div class="hist-right"><span class="hist-min">${s.minutes} min</span><button class="del-btn" data-id="${s.id}">×</button></div>
    </div>`;
  }).join('');
  list.querySelectorAll('.del-btn').forEach(b=>{
    b.addEventListener('click', async ()=>{
      await deleteSession(b.dataset.id);
      await refreshEverything();
      showToast('সেশন মুছে ফেলা হয়েছে');
    });
  });
}

/* ---------- report export ---------- */
function getExportSessions(){
  const range = document.getElementById('exportRange').value;
  const allSess = [...sessions, ...nonStudySessions];
  if(range === 'all') return allSess;
  if(range === 'today') {
    const today = todayStr();
    return allSess.filter(s => s.date === today);
  }
  if(range === '24h') {
    const limit = Date.now() - 24 * 3600 * 1000;
    return allSess.filter(s => s.ts >= limit);
  }
  if(range === '48h') {
    const limit = Date.now() - 48 * 3600 * 1000;
    return allSess.filter(s => s.ts >= limit);
  }
  
  const limitDate = daysAgoStr(parseInt(range));
  return allSess.filter(s => s.date >= limitDate);
}



const b2eSubject = {
  'বাংলা': 'Bengali', 'ইংরেজি': 'English', 'অংক': 'Math', 
  'জীবন বিজ্ঞান': 'Life Science', 'ভৌত বিজ্ঞান': 'Physical Science', 
  'ইতিহাস': 'History', 'ভূগোল': 'Geography'
};
const b2eWorkType = {
  'রিভিশন': 'Revision', 'নতুন পড়া': 'New Topic', 'মুখস্থ করা': 'Memorize', 
  'রিডিং পড়া': 'Reading', 'প্রশ্ন উত্তর প্র্যাকটিস': 'Practice', 
  'নোট তৈরি': 'Notes', 'অন্যান্য': 'Other'
};

function toBanglish(str) {
  if (!str) return '';
  const map = {
    'অ':'o','আ':'a','ই':'i','ঈ':'i','উ':'u','ঊ':'u','ঋ':'ri','এ':'e','ঐ':'oi','ও':'o','ঔ':'ou',
    'ক':'k','খ':'kh','গ':'g','ঘ':'gh','ঙ':'ng','চ':'ch','ছ':'ch','জ':'j','ঝ':'jh','ঞ':'n',
    'ট':'t','ঠ':'th','ড':'d','ঢ':'dh','ণ':'n','ত':'t','থ':'th','দ':'d','ধ':'dh','ন':'n',
    'প':'p','ফ':'f','ব':'b','ভ':'v','ম':'m','য':'j','র':'r','ল':'l','শ':'sh','ষ':'sh','স':'s','হ':'h',
    'ড়':'r','ঢ়':'rh','য়':'y','ৎ':'t','ং':'ng','ঁ':'','ঃ':'h',
    'া':'a','ি':'i','ী':'i','ু':'u','ূ':'u','ৃ':'ri','ে':'e','ৈ':'oi','ো':'o','ৌ':'ou','্':''
  };
  let res = '';
  for(let i=0; i<str.length; i++){
    res += map[str[i]] !== undefined ? map[str[i]] : str[i];
  }
  return res.replace(/a+/g, 'a').replace(/i+/g, 'i');
}

async function translateBatch(strings) {
  if (!strings || strings.length === 0) return {};
  const query = strings.join(' ||| ');
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=bn&tl=en&dt=t&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    let translated = '';
    json[0].forEach(part => translated += part[0]);
    const translatedParts = translated.split('|||').map(s => s.trim());
    const resultMap = {};
    strings.forEach((s, i) => { resultMap[s] = translatedParts[i] || s; });
    return resultMap;
  } catch(e) {
    console.error('Translation API failed:', e);
    const fallbackMap = {};
    strings.forEach(s => fallbackMap[s] = toBanglish(s));
    return fallbackMap;
  }
}

document.getElementById('exportPdfBtn').addEventListener('click', async ()=>{
  const data = getExportSessions();
  if(data.length===0){ showToast('No data to export'); return; }
  
  const btn = document.getElementById('exportPdfBtn');
  btn.textContent = 'Translating...';
  btn.disabled = true;

  try {
    const uniqueStrings = new Set();
    data.forEach(s => {
      if (s.subject && !b2eSubject[s.subject]) uniqueStrings.add(s.subject);
      if (s.workType && !b2eWorkType[s.workType]) uniqueStrings.add(s.workType);
    });
    
    const translationMap = await translateBatch(Array.from(uniqueStrings));
    
    function getEn(str, isSubject) {
      if(!str) return '';
      if(isSubject && b2eSubject[str]) return b2eSubject[str];
      if(!isSubject && b2eWorkType[str]) return b2eWorkType[str];
      return translationMap[str] || str;
    }

    btn.textContent = 'Preparing...';

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    const range = document.getElementById('exportRange').value;
    let titleStr = 'Study Report';
    if(range === 'all') titleStr = 'Full Study Report';
    else if(range === 'today') titleStr = 'Study Report (Today)';
    else if(range === '24h') titleStr = 'Study Report (Last 24h)';
    else if(range === '48h') titleStr = 'Study Report (Last 48h)';
    else titleStr = `Study Report (Last ${range} Days)`;
    
    let studyMin = 0; let nonStudyMin = 0;
    data.forEach(s => {
      const isNS = s.isNonStudy || (s.id && String(s.id).startsWith('ns'));
      if(isNS) nonStudyMin += s.minutes;
      else studyMin += s.minutes;
    });
    
    const studyHr = (studyMin/60).toFixed(1);
    const nonStudyHr = (nonStudyMin/60).toFixed(1);

    doc.setFontSize(18);
    doc.text('Focus Study Timer', 14, 22);
    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(titleStr, 14, 30);
    
    doc.setFontSize(11);
    doc.setTextColor(0);
    doc.text(`Total Study: ${studyHr} hrs`, 14, 40);
    doc.text(`Non-Study: ${nonStudyHr} hrs`, 14, 46);

    const tableData = data.sort((a,b)=>(a.ts||0) - (b.ts||0)).map(s => {
      const isNS = s.isNonStudy || (s.id && String(s.id).startsWith('ns')) ? 'Non-Study' : 'Study';
      const timeRange = s.ts ? formatTimeRangeOnlyTime(s.ts, s.minutes) : '-';
      return [
        s.date, 
        timeRange, 
        getEn(s.subject, true), 
        getEn(s.workType || 'N/A', false), 
        `${s.minutes} min`, 
        isNS
      ];
    });

    doc.autoTable({
      startY: 52,
      head: [['Date', 'Time', 'Subject', 'Work Type', 'Minutes', 'Category']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [201, 150, 47] },
      alternateRowStyles: { fillColor: [250, 250, 250] },
      styles: { fontSize: 10 },
      columnStyles: {
        0: { cellWidth: 24 }, 
        1: { cellWidth: 38 }, 
        2: { cellWidth: 'auto' }, 
        3: { cellWidth: 26 }, 
        4: { cellWidth: 18 }, 
        5: { cellWidth: 24 }  
      }
    });

    doc.save('focus-timer-report.pdf');
  } catch(err) {
    console.error(err);
    showToast('PDF Export failed');
  } finally {
    btn.textContent = 'PDF';
    btn.disabled = false;
  }
});

/* ---------- JSON Backup & Restore ---------- */
document.getElementById('backupJsonBtn').addEventListener('click', ()=>{
  const backupData = { timestamp: Date.now(), sessions, nonStudySessions };
  const jsonStr = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonStr], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `focus-timer-backup-${todayStr()}.json`;
  a.click();
  showToast('ডেটা ব্যাকআপ ডাউনলোড শুরু হয়েছে');
});

document.getElementById('restoreJsonBtn').addEventListener('click', ()=>{
  document.getElementById('restoreFileInput').click();
});

document.getElementById('restoreFileInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if(!data.sessions || !data.nonStudySessions) { showToast('Invalid backup file'); return; }
      
      let newSessCount = 0; let newNonStudyCount = 0;
      for (const ns of data.nonStudySessions) {
        if(!nonStudySessions.find(s => s.id === ns.id && s.ts === ns.ts)) {
          nonStudySessions.push(ns); newNonStudyCount++;
          if(currentUser) { await setDoc(doc(db, 'users', currentUser.uid, 'nonStudySessions', ns.id), ns); }
        }
      }
      
      if(!currentUser){ localSet('st_nonstudy_sessions', nonStudySessions); }

      for (const s of data.sessions) {
        if(!sessions.find(curr => curr.id === s.id && curr.ts === s.ts)) {
          sessions.push(s); newSessCount++;
          if(currentUser) { await setDoc(doc(db, 'users', currentUser.uid, 'sessions', s.id), s); }
        }
      }
      
      if(!currentUser){ localSet(LS_SESSIONS, sessions); }
      await refreshEverything();
      showToast(`রিস্টোর সফল: ${newSessCount} study, ${newNonStudyCount} non-study added!`);
    } catch(err) {
      console.error(err); showToast('Error reading backup file');
    }
  };
  reader.readAsText(file);
  e.target.value = ''; 
});

/* ---------- refresh everything ---------- */
async function refreshEverything(){
  renderTarget(); renderLevel(); renderCompare(); renderStats(); renderStreak(); renderHeatmap(); renderHistory(); renderSubjectAnalytics();
}

/* ---------- init / resume timer across reload (local only) ---------- */
function initTimerFromLocalState(){
  const state = localGet(LS_TIMERSTATE, null);
  if(!state) return;
  
  selectedSubject = state.subject || prefs.subjects[0]?.name; 
  selectedSubMenu = state.subMenu || '';
  selectedWorkType = state.workType || 'রিভিশন';

  totalSeconds = state.totalSeconds;
  stopwatchMode = !!state.stopwatchMode;
  pomodoroMode = !!state.pomodoroMode; pomoPhase = state.pomoPhase || 'work';
  pomoToggle.checked = pomodoroMode;
  customTimeRow.style.display = pomodoroMode ? 'none' : 'flex';
  phaseBadge.style.display = pomodoroMode ? 'block' : 'none';
  updatePhaseBadge();
  
  isTimerActive = !!state.running || (state.remaining !== undefined && state.remaining < totalSeconds && !stopwatchMode) || (state.remaining !== undefined && state.remaining > 0 && stopwatchMode);

  if(state.running){
    if(stopwatchMode){
      startAt = state.startAt;
      remaining = (Date.now()-startAt)/1000;
      startTimer(true);
    } else {
      remaining = Math.max(0,(state.endTime-Date.now())/1000);
      if(remaining<=0){ finish(); }
      else { endTime = state.endTime; startTimer(true); }
    }
  } else {
    remaining = state.remaining;
    if(stopwatchMode){
      startAt = state.startAt;
    } else {
      endTime = state.endTime;
    }
    hoursEl.disabled=true; minutesEl.disabled=true;
    hintEl.textContent = stopwatchMode ? 'বিরতিতে আছে — চালিয়ে যেতে Start চাপো (Reset চাপলে সময় সেভ হবে)' : 'বিরতিতে আছে — চালিয়ে যেতে Start চাপো';
    startBtn.disabled=false; pauseBtn.disabled=true;
    render();
  }
  renderSelectionChips();
}

document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) render(); });

(async function init(){
  renderAuthBar();
  await loadAll();
  
  if(selectedSubject !== '' && !prefs.subjects.find(s => s.name === selectedSubject)) {
    selectedSubject = prefs.subjects[0]?.name || '';
  }
  if(selectedWorkType !== '' && !prefs.workTypes.includes(selectedWorkType)) {
    selectedWorkType = prefs.workTypes[0] || '';
  }
  
  renderSelectionChips();
  initTimerFromLocalState();
  await refreshEverything();
})();

/* ---------- Service Worker Registration (PWA) ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(registration => {
      console.log('SW registered: ', registration.scope);
    });
  });
}

/* ---------- Bottom Navigation ---------- */
document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
  item.addEventListener('click', () => {
    // Remove active class from all items
    document.querySelectorAll('.bottom-nav .nav-item').forEach(nav => nav.classList.remove('active'));
    // Add active class to clicked item
    item.classList.add('active');

    // Hide all view sections
    document.querySelectorAll('.view-section').forEach(view => view.classList.remove('active'));
    // Show target view
    const targetId = item.getAttribute('data-target');
    document.getElementById(targetId).classList.add('active');
  });
});

/* ---------- Bulk Delete ---------- */
document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
  const fromDate = document.getElementById('bulkDelFrom').value;
  const toDate = document.getElementById('bulkDelTo').value;

  if(!fromDate || !toDate) {
    showToast('অনুগ্রহ করে From এবং To তারিখ সিলেক্ট করুন!');
    return;
  }
  if(fromDate > toDate) {
    showToast('From তারিখ To তারিখের চেয়ে বড় হতে পারে না!');
    return;
  }

  const allSess = [...sessions, ...nonStudySessions];
  const toDelete = allSess.filter(s => s.date >= fromDate && s.date <= toDate);
  
  if(toDelete.length === 0) {
    showToast('এই তারিখের মধ্যে কোনো সেশন পাওয়া যায়নি!');
    return;
  }

  if(confirm(`আপনি কি নিশ্চিত যে ${fromDate} থেকে ${toDate} তারিখের ${toDelete.length} টি সেশন মুছে ফেলতে চান? এটি আর ফেরত পাওয়া যাবে না!`)) {
    if (currentUser) {
      try {
        for (let i = 0; i < toDelete.length; i += 500) {
          const batch = writeBatch(db);
          const chunk = toDelete.slice(i, i + 500);
          chunk.forEach(s => {
            const isNS = s.isNonStudy || (s.id && String(s.id).startsWith('ns'));
            const colName = isNS ? 'nonStudySessions' : 'sessions';
            batch.delete(doc(db, 'users', currentUser.uid, colName, s.id));
          });
          await batch.commit();
        }
        sessions = sessions.filter(s => !toDelete.some(d => d.id === s.id));
        nonStudySessions = nonStudySessions.filter(s => !toDelete.some(d => d.id === s.id));
      } catch(err) {
        console.error(err);
        showToast('ডিলিট করতে সমস্যা হয়েছে!');
        return;
      }
    } else {
      for(const s of toDelete) {
        await deleteSession(s.id);
      }
    }
    await refreshEverything();
    showToast(`${toDelete.length} টি সেশন সফলভাবে মুছে ফেলা হয়েছে!`);
  }
});

/* ---------- Advanced Features (Glowing, Confetti, Sub-subjects, Analytics) ---------- */

// 1. Confetti Logic
function triggerConfetti() {
  const container = document.getElementById('particles');
  if(!container) return;
  container.innerHTML = ''; // clear old
  const colors = ['#FFDF00', '#c9962f', '#FFF8DC', '#DAA520'];
  for (let i = 0; i < 50; i++) {
    const p = document.createElement('div');
    p.classList.add('particle');
    p.style.left = (Math.random() * 100) + 'vw';
    p.style.top = '-20px';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    const size = Math.random() * 8 + 4;
    p.style.width = size + 'px'; p.style.height = size + 'px';
    if(Math.random() > 0.5) p.style.borderRadius = '0'; // squares
    const duration = Math.random() * 2 + 1.5;
    const delay = Math.random() * 0.5;
    p.style.animationDuration = duration + 's';
    p.style.animationDelay = delay + 's';
    container.appendChild(p);
    setTimeout(() => p.remove(), (duration + delay) * 1000);
  }
}

// Intercept renderTarget to trigger confetti when reaching target
const oldRenderTarget = renderTarget;
renderTarget = function() {
  const today = todayStr();
  const prevDone = parseInt(document.getElementById('targetDone').getAttribute('data-prev') || '0');
  oldRenderTarget();
  const done = sessions.filter(s=>s.date===today).reduce((a,s)=>a+s.minutes,0);
  document.getElementById('targetDone').setAttribute('data-prev', done);
  
  if (prevDone < prefs.dailyTarget && done >= prefs.dailyTarget) {
    triggerConfetti();
    showToast('🎉 আজকের লক্ষ্য পূরণ হয়েছে! অসাধারণ কাজ!');
  }
};

// 2. Sub-subject logic removed as it's now part of the unified Add Modal.

// 3. 7-Day Subject Analytics Logic
function renderSubjectAnalytics() {
  const listContainer = document.getElementById('subjectRankingList');
  if(!listContainer) return;
  
  // Get date 7 days ago
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const sevenDaysAgoStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  // Filter study sessions (exclude non-study)
  const recentSessions = sessions.filter(s => s.date >= sevenDaysAgoStr);
  
  const subjMap = {};
  recentSessions.forEach(s => {
    // Group by main subject (if saved as "Subject - Sub", extract main subject or just group by the raw string)
    // Actually, user wants sub-subjects to be ranked if we want, but "7TI SUBJECT ER JONNO BATCH"
    // Let's rank by the exact saved subject string (which includes sub-subject)
    const name = s.subject;
    subjMap[name] = (subjMap[name] || 0) + s.minutes;
  });

  const sorted = Object.entries(subjMap).sort((a,b) => b[1] - a[1]);
  
  if (sorted.length === 0) {
    listContainer.innerHTML = '<div style="color:var(--text-dim); font-size:0.9rem;">গত ৭ দিনে কোনো পড়াশোনা হয়নি।</div>';
    return;
  }

  listContainer.innerHTML = sorted.map((entry, index) => {
    const name = entry[0];
    const mins = entry[1];
    
    let badgeClass = 'normal';
    let badgeIcon = `${index + 1}`;
    
    if (index === 0) { badgeClass = 'gold'; badgeIcon = '🏆'; }
    else if (index === 1) { badgeClass = 'silver'; badgeIcon = '🥈'; }
    else if (index === 2) { badgeClass = 'bronze'; badgeIcon = '🥉'; }

    return `
      <div class="subj-rank-item">
        <div class="badge ${badgeClass}">${badgeIcon}</div>
        <div class="rank-subj-name">${name}</div>
        <div class="rank-subj-time">${mins} মিনিট</div>
      </div>
    `;
  }).join('');
}
