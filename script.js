import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  writeBatch,
  collection,
  getDocs,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCeIycD9PsF8_aJgBgB33vQzs7aL_AahYU",
  authDomain: "project-9e728.firebaseapp.com",
  projectId: "project-9e728",
  storageBucket: "project-9e728.firebasestorage.app",
  messagingSenderId: "298902348677",
  appId: "1:298902348677:web:6d31128c2547ca82801aec",
  measurementId: "G-69N2GNC89Q",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const RESERVATION_SECONDS = 6 * 60 * 60;
const AWAY_SECONDS = 60 * 60;
const EXTEND_AVAILABLE_SECONDS = 60 * 60;
const DATA_VERSION = "empty-seats-v13";
const MAP_ZOOM = 0.74;

const ROOMS = [
  { id: "general3", name: "3층 일반 열람실", total: 168 },
  { id: "laptop3", name: "3층 노트북 열람실", total: 180 },
  { id: "general4", name: "4층 일반 열람실", total: 234 },
  { id: "laptop4", name: "4층 노트북 열람실", total: 180 },
];

class FirebaseSeatApi {
  idToEmail(id) {
    return `${id.trim().toLowerCase()}@seatcheck.local`;
  }

  async signup(id, password) {
    const cleanId = id.trim();

    if (!cleanId) {
      throw new Error("아이디를 입력해주세요.");
    }

    if (password.length < 6) {
      throw new Error("비밀번호는 6자 이상이어야 합니다.");
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, this.idToEmail(cleanId), password);

      await setDoc(doc(db, "users", userCredential.user.uid), {
        loginId: cleanId,
        createdAt: serverTimestamp(),
        currentReservationId: null,
      });

      return userCredential.user;
    } catch (error) {
      throw this.convertAuthError(error);
    }
  }

  async login(id, password) {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, this.idToEmail(id), password);
      return userCredential.user;
    } catch (error) {
      throw this.convertAuthError(error);
    }
  }

  async logout() {
    await signOut(auth);
  }

  async getCurrentUserProfile() {
    const user = auth.currentUser;
    if (!user) return null;

    const snapshot = await getDoc(doc(db, "users", user.uid));
    return snapshot.exists() ? snapshot.data() : null;
  }

  async ensureDatabaseReady() {
    const setupRef = doc(db, "system", "setup");
    const setupSnapshot = await getDoc(setupRef);
    const setupData = setupSnapshot.exists() ? setupSnapshot.data() : null;

    if (setupData && setupData.version === DATA_VERSION) {
      return;
    }

    const setupPanel = document.querySelector("#setupPanel");
    if (setupPanel) setupPanel.classList.remove("hidden");

    const writes = [];

    ROOMS.forEach((room) => {
      writes.push({
        type: "set",
        ref: doc(db, "rooms", room.id),
        data: {
          name: room.name,
          total: room.total,
          updatedAt: serverTimestamp(),
        },
      });

      for (let seatId = 1; seatId <= room.total; seatId += 1) {
        writes.push({
          type: "set",
          ref: doc(db, "seats", `${room.id}_${seatId}`),
          data: {
            roomId: room.id,
            seatId,
            status: "empty",
            reservedBy: null,
            reservedUntil: null,
            awayUntil: null,
            lastTempDetectedAt: null,
            tempWarning: false,
            tempWarningAt: null,
            updatedAt: serverTimestamp(),
          },
        });
      }
    });

    const reservationSnapshot = await getDocs(collection(db, "reservations"));
    reservationSnapshot.forEach((item) => {
      writes.push({ type: "delete", ref: item.ref });
    });

    const userSnapshot = await getDocs(collection(db, "users"));
    userSnapshot.forEach((item) => {
      writes.push({
        type: "update",
        ref: item.ref,
        data: { currentReservationId: null },
      });
    });

    writes.push({
      type: "set",
      ref: setupRef,
      data: {
        completed: true,
        version: DATA_VERSION,
        updatedAt: serverTimestamp(),
      },
    });

    await commitInChunks(writes, 400);

    if (setupPanel) setupPanel.classList.add("hidden");
  }

  async getSeats() {
    const snapshot = await getDocs(collection(db, "seats"));
    const seatsByRoom = {};

    ROOMS.forEach((room) => {
      seatsByRoom[room.id] = [];
    });

    snapshot.forEach((item) => {
      const seat = item.data();
      if (!seatsByRoom[seat.roomId]) return;

      seatsByRoom[seat.roomId].push({
        ...seat,
        status: this.getSeatViewStatus(seat),
      });
    });

    ROOMS.forEach((room) => {
      seatsByRoom[room.id].sort((a, b) => a.seatId - b.seatId);
    });

    return seatsByRoom;
  }

  getSeatViewStatus(seat) {
    const user = auth.currentUser;

    if (user && seat.reservedBy === user.uid && seat.status === "reserved") {
      return "mine";
    }

    return seat.status;
  }

  async getMyReservation() {
    const user = auth.currentUser;
    if (!user) return null;

    const snapshot = await getDoc(doc(db, "reservations", user.uid));
    return snapshot.exists() ? snapshot.data() : null;
  }

  async reserveSeat(roomId, seatId) {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");

    const seatRef = doc(db, "seats", `${roomId}_${seatId}`);
    const reservationRef = doc(db, "reservations", user.uid);
    const userRef = doc(db, "users", user.uid);

    await runTransaction(db, async (transaction) => {
      const seatSnapshot = await transaction.get(seatRef);
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!seatSnapshot.exists()) {
        throw new Error("존재하지 않는 좌석입니다.");
      }

      if (reservationSnapshot.exists()) {
        throw new Error("이미 예약한 좌석이 있습니다. 먼저 기존 좌석을 반납하세요.");
      }

      const seat = seatSnapshot.data();

      if (seat.status !== "empty") {
        throw new Error("이미 예약된 좌석입니다.");
      }

      const reservedUntil = Timestamp.fromDate(new Date(Date.now() + RESERVATION_SECONDS * 1000));

      transaction.update(seatRef, {
        status: "reserved",
        reservedBy: user.uid,
        reservedUntil,
        awayUntil: null,
        updatedAt: serverTimestamp(),
      });

      transaction.set(reservationRef, {
        roomId,
        seatId,
        status: "reserved",
        startedAt: serverTimestamp(),
        reservedUntil,
        awayUntil: null,
        hasUsedAway: false,
      });

      transaction.update(userRef, {
        currentReservationId: user.uid,
      });
    });
  }

  async returnSeat() {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");

    const reservationRef = doc(db, "reservations", user.uid);
    const userRef = doc(db, "users", user.uid);

    await runTransaction(db, async (transaction) => {
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!reservationSnapshot.exists()) {
        throw new Error("반납할 좌석이 없습니다.");
      }

      const reservation = reservationSnapshot.data();
      const seatRef = doc(db, "seats", `${reservation.roomId}_${reservation.seatId}`);

      transaction.update(seatRef, {
        status: "empty",
        reservedBy: null,
        reservedUntil: null,
        awayUntil: null,
        updatedAt: serverTimestamp(),
      });

      transaction.delete(reservationRef);
      transaction.update(userRef, { currentReservationId: null });
    });
  }

  async markAway() {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");

    const reservationRef = doc(db, "reservations", user.uid);

    await runTransaction(db, async (transaction) => {
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!reservationSnapshot.exists()) {
        throw new Error("외출 처리할 좌석이 없습니다.");
      }

      const reservation = reservationSnapshot.data();

      if (reservation.status === "away") {
        throw new Error("이미 외출 상태입니다.");
      }

      if (reservation.hasUsedAway === true) {
        throw new Error("외출은 예약 한 번당 한 번만 사용할 수 있습니다.");
      }

      const seatRef = doc(db, "seats", `${reservation.roomId}_${reservation.seatId}`);
      const awayUntil = Timestamp.fromDate(new Date(Date.now() + AWAY_SECONDS * 1000));

      transaction.update(seatRef, {
        status: "away",
        awayUntil,
        updatedAt: serverTimestamp(),
      });

      transaction.update(reservationRef, {
        status: "away",
        awayUntil,
        hasUsedAway: true,
      });
    });
  }

  async returnFromAway() {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");

    const reservationRef = doc(db, "reservations", user.uid);

    await runTransaction(db, async (transaction) => {
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!reservationSnapshot.exists()) {
        throw new Error("복귀할 좌석이 없습니다.");
      }

      const reservation = reservationSnapshot.data();

      if (reservation.status !== "away") {
        throw new Error("현재 외출 상태가 아닙니다.");
      }

      const seatRef = doc(db, "seats", `${reservation.roomId}_${reservation.seatId}`);

      transaction.update(seatRef, {
        status: "reserved",
        awayUntil: null,
        updatedAt: serverTimestamp(),
      });

      transaction.update(reservationRef, {
        status: "reserved",
        awayUntil: null,
      });
    });
  }

  async extendReservation() {
    const user = auth.currentUser;
    if (!user) throw new Error("로그인이 필요합니다.");

    const reservationRef = doc(db, "reservations", user.uid);

    await runTransaction(db, async (transaction) => {
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!reservationSnapshot.exists()) {
        throw new Error("연장할 예약이 없습니다.");
      }

      const reservation = reservationSnapshot.data();

      if (reservation.status === "away") {
        throw new Error("외출 중에는 연장할 수 없습니다.");
      }

      const remainingSeconds = Math.floor((reservation.reservedUntil.toDate().getTime() - Date.now()) / 1000);

      if (remainingSeconds > EXTEND_AVAILABLE_SECONDS) {
        throw new Error("연장은 남은 시간이 1시간 이하일 때부터 가능합니다.");
      }

      const reservedUntil = Timestamp.fromDate(new Date(Date.now() + RESERVATION_SECONDS * 1000));
      const seatRef = doc(db, "seats", `${reservation.roomId}_${reservation.seatId}`);

      transaction.update(seatRef, {
        reservedUntil,
        updatedAt: serverTimestamp(),
      });

      transaction.update(reservationRef, {
        reservedUntil,
      });
    });
  }

  convertAuthError(error) {
    const messages = {
      "auth/email-already-in-use": "동일한 ID가 있습니다.",
      "auth/invalid-email": "아이디 형식이 올바르지 않습니다.",
      "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
      "auth/invalid-credential": "아이디 또는 비밀번호가 올바르지 않습니다.",
      "auth/user-not-found": "아이디 또는 비밀번호가 올바르지 않습니다.",
      "auth/wrong-password": "아이디 또는 비밀번호가 올바르지 않습니다.",
      "auth/network-request-failed": "네트워크 연결을 확인해주세요.",
    };

    return new Error(messages[error.code] || error.message || "요청 처리 중 오류가 발생했습니다.");
  }
}

async function commitInChunks(writes, chunkSize) {
  for (let index = 0; index < writes.length; index += chunkSize) {
    const batch = writeBatch(db);
    const chunk = writes.slice(index, index + chunkSize);

    chunk.forEach((write) => {
      if (write.type === "delete") {
        batch.delete(write.ref);
      } else if (write.type === "update") {
        batch.update(write.ref, write.data);
      } else {
        batch.set(write.ref, write.data);
      }
    });

    await batch.commit();
  }
}

const api = new FirebaseSeatApi();

const screens = {
  loading: document.querySelector("#loadingScreen"),
  login: document.querySelector("#loginScreen"),
  signup: document.querySelector("#signupScreen"),
  app: document.querySelector("#appScreen"),
};

const loginForm = document.querySelector("#loginForm");
const signupForm = document.querySelector("#signupForm");
const loginMessage = document.querySelector("#loginMessage");
const signupMessage = document.querySelector("#signupMessage");
const roomTabs = document.querySelector("#roomTabs");
const reserveButton = document.querySelector("#reserveButton");
const seatMap = document.querySelector("#seatMap");
const mapViewport = document.querySelector("#mapViewport");
const myRoomTitle = document.querySelector("#myRoomTitle");
const mySeatTitle = document.querySelector("#mySeatTitle");
const mySeatStatus = document.querySelector("#mySeatStatus");
const remainTime = document.querySelector("#remainTime");
const timeLabel = document.querySelector("#timeLabel");
const manageMessage = document.querySelector("#manageMessage");
const returnButton = document.querySelector("#returnButton");
const leaveButton = document.querySelector("#leaveButton");
const extendButton = document.querySelector("#extendButton");
const extensionGuide = document.querySelector(".extension-guide");
const manageActions = document.querySelector(".manage-actions");
const confirmModal = document.querySelector("#confirmModal");
const awayModal = document.querySelector("#awayModal");
const returnAwayModal = document.querySelector("#returnAwayModal");
const sheetRoomName = document.querySelector("#sheetRoomName");
const sheetSeatName = document.querySelector("#sheetSeatName");
const bottomSheet = document.querySelector("#bottomSheet");
const reservationBar = document.querySelector("#reservationBar");
const managePanel = document.querySelector("#managePanel");
const sheetToggleButton = document.querySelector("#sheetToggleButton");
const timerProgress = document.querySelector("#timerProgress");
const awayTimerRing = document.querySelector("#awayTimerRing");
const awayTimerProgress = document.querySelector("#awayTimerProgress");
const awayRemainTime = document.querySelector("#awayRemainTime");

const TIMER_CIRCUMFERENCE = 2 * Math.PI * 96;

let currentRoomId = ROOMS[0].id;
let seatsByRoom = {};
let selectedSeatId = null;
let timerId = null;
let isSheetExpanded = false;
let hasActiveReservation = false;
let activeReservation = null;
let isAutoReturning = false;

function showScreen(screenName) {
  if (window.showSeatCheckScreen) {
    window.showSeatCheckScreen(screenName);
    return;
  }

  Object.values(screens).forEach((screen) => {
    if (screen) screen.classList.remove("active");
  });

  if (screens[screenName]) {
    screens[screenName].classList.add("active");
  }
}

function setMessage(element, text, type = "") {
  if (!element) return;
  element.textContent = text;
  element.className = `message ${type}`.trim();
}

function getCurrentRoom() {
  return ROOMS.find((room) => room.id === currentRoomId);
}

async function setupAppForUser() {
  showScreen("app");
  await api.getCurrentUserProfile();
  await api.ensureDatabaseReady();
  await refreshApp();
}

async function refreshApp() {
  seatsByRoom = await api.getSeats();
  renderRoomTabs();
  renderSeats();
  await renderReservation();
}

function resetMapPosition() {
  if (!mapViewport) return;
  mapViewport.scrollLeft = 0;
  mapViewport.scrollTop = 0;
}

function renderRoomTabs() {
  roomTabs.innerHTML = "";

  ROOMS.forEach((room) => {
    const roomSeats = seatsByRoom[room.id] || [];
    const emptyCount = roomSeats.filter((seat) => seat.status === "empty").length;

    const button = document.createElement("button");
    button.className = room.id === currentRoomId ? "room-tab active" : "room-tab";
    button.type = "button";
    button.innerHTML = `
      <strong>${room.name}</strong>
      <span>${emptyCount}/${room.total} 남음</span>
    `;

    button.addEventListener("click", () => {
      currentRoomId = room.id;
      selectedSeatId = null;
      collapseSheet();
      resetMapPosition();
      renderRoomTabs();
      renderSeats();
      renderReservation();
    });

    roomTabs.appendChild(button);
  });
}

function renderSeats() {
  const room = getCurrentRoom();
  const seats = seatsByRoom[currentRoomId] || [];
  const layoutData = createLayout(currentRoomId, room.total);

  sheetRoomName.textContent = room.name;

  if (!hasActiveReservation) {
    sheetSeatName.textContent = selectedSeatId ? `${selectedSeatId}번` : "좌석을 선택해주세요";
    reserveButton.textContent = "예약하기";
    reserveButton.disabled = !selectedSeatId;
  }

  seatMap.innerHTML = "";
  seatMap.style.setProperty("--map-width", `${Math.ceil(layoutData.width * MAP_ZOOM)}px`);
  seatMap.style.setProperty("--map-height", `${Math.ceil(layoutData.height * MAP_ZOOM)}px`);

  layoutData.groups.forEach((group) => {
    const groupElement = document.createElement("div");
    groupElement.className = `seat-group ${group.cols === 3 ? "cols-3" : "cols-2"}`;
    groupElement.style.left = `${Math.round(group.x * MAP_ZOOM)}px`;
    groupElement.style.top = `${Math.round(group.y * MAP_ZOOM)}px`;

    group.seatIds.forEach((seatId) => {
      const seat = seats.find((item) => item.seatId === seatId);
      if (!seat) return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = `seat ${seat.status}`;
      button.textContent = getSeatText(seat);
      button.disabled = hasActiveReservation || seat.status !== "empty";

      if (selectedSeatId === seatId) {
        button.classList.add("selected");
      }

      button.setAttribute("aria-label", `${seatId}번 좌석 ${getStatusText(seat.status)}`);

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        // 좌석을 누른 채로 드래그한 경우에는 클릭 선택으로 처리하지 않습니다.
        if (mapViewport.dataset.dragged === "true") return;

        if (seat.status !== "empty" || hasActiveReservation) return;

        selectedSeatId = seatId;
        renderSeats();
      });

      groupElement.appendChild(button);
    });

    seatMap.appendChild(groupElement);
  });
}

function getSeatText(seat) {
  // 좌석 상태와 관계없이 배치도에는 항상 좌석 번호만 표시합니다.
  return seat.seatId;
}

function createLayout(roomId, total) {
  const builders = {
    general3: buildGeneral3Layout,
    laptop3: buildLaptop3Layout,
    general4: buildGeneral4Layout,
    laptop4: buildLaptop4Layout,
  };

  return builders[roomId] ? builders[roomId](total) : buildGeneral3Layout(total);
}

function pushSequentialGroups(groups, options) {
  const {
    startSeat,
    endSeat,
    startX,
    startY,
    groupsPerRow,
    groupSize,
    cols,
    colGap,
    rowGap,
    aisleAfterCol = null,
    aisleX = 0,
  } = options;

  let seatId = startSeat;
  let groupIndex = 0;

  while (seatId <= endSeat) {
    const row = Math.floor(groupIndex / groupsPerRow);
    const col = groupIndex % groupsPerRow;
    const seatIds = [];

    for (let index = 0; index < groupSize && seatId <= endSeat; index += 1) {
      seatIds.push(seatId);
      seatId += 1;
    }

    groups.push({
      x: startX + col * colGap + (aisleAfterCol !== null && col >= aisleAfterCol ? aisleX : 0),
      y: startY + row * rowGap,
      cols,
      seatIds,
    });

    groupIndex += 1;
  }
}

function buildGeneral3Layout(total) {
  const groups = [];

  pushSequentialGroups(groups, {
    startSeat: 1,
    endSeat: Math.min(72, total),
    startX: 30,
    startY: 30,
    groupsPerRow: 6,
    groupSize: 4,
    cols: 2,
    colGap: 132,
    rowGap: 122,
    aisleAfterCol: 3,
    aisleX: 40,
  });

  pushSequentialGroups(groups, {
    startSeat: 73,
    endSeat: Math.min(120, total),
    startX: 170,
    startY: 450,
    groupsPerRow: 4,
    groupSize: 4,
    cols: 2,
    colGap: 142,
    rowGap: 124,
    aisleAfterCol: 2,
    aisleX: 52,
  });

  pushSequentialGroups(groups, {
    startSeat: 121,
    endSeat: Math.min(168, total),
    startX: 170,
    startY: 820,
    groupsPerRow: 4,
    groupSize: 4,
    cols: 2,
    colGap: 142,
    rowGap: 124,
    aisleAfterCol: 2,
    aisleX: 52,
  });

  return { width: 900, height: 1200, groups };
}

function buildLaptop3Layout(total) {
  const groups = [];

  pushSequentialGroups(groups, {
    startSeat: 1,
    endSeat: Math.min(96, total),
    startX: 30,
    startY: 30,
    groupsPerRow: 6,
    groupSize: 4,
    cols: 2,
    colGap: 132,
    rowGap: 122,
    aisleAfterCol: 3,
    aisleX: 42,
  });

  pushSequentialGroups(groups, {
    startSeat: 97,
    endSeat: Math.min(120, total),
    startX: 270,
    startY: 585,
    groupsPerRow: 3,
    groupSize: 4,
    cols: 2,
    colGap: 152,
    rowGap: 122,
  });

  pushSequentialGroups(groups, {
    startSeat: 121,
    endSeat: Math.min(180, total),
    startX: 92,
    startY: 790,
    groupsPerRow: 5,
    groupSize: 4,
    cols: 2,
    colGap: 142,
    rowGap: 124,
    aisleAfterCol: 3,
    aisleX: 46,
  });

  return { width: 940, height: 1250, groups };
}

function buildGeneral4Layout(total) {
  const groups = [];

  pushSequentialGroups(groups, {
    startSeat: 1,
    endSeat: Math.min(132, total),
    startX: 30,
    startY: 30,
    groupsPerRow: 5,
    groupSize: 6,
    cols: 3,
    colGap: 172,
    rowGap: 132,
    aisleAfterCol: 3,
    aisleX: 54,
  });

  pushSequentialGroups(groups, {
    startSeat: 133,
    endSeat: Math.min(150, total),
    startX: 365,
    startY: 735,
    groupsPerRow: 3,
    groupSize: 6,
    cols: 3,
    colGap: 178,
    rowGap: 132,
  });

  pushSequentialGroups(groups, {
    startSeat: 151,
    endSeat: Math.min(234, total),
    startX: 185,
    startY: 950,
    groupsPerRow: 5,
    groupSize: 6,
    cols: 3,
    colGap: 172,
    rowGap: 134,
    aisleAfterCol: 3,
    aisleX: 54,
  });

  return { width: 1120, height: 1500, groups };
}

function buildLaptop4Layout(total) {
  const groups = [];

  pushSequentialGroups(groups, {
    startSeat: 1,
    endSeat: Math.min(80, total),
    startX: 30,
    startY: 30,
    groupsPerRow: 5,
    groupSize: 4,
    cols: 2,
    colGap: 142,
    rowGap: 126,
    aisleAfterCol: 3,
    aisleX: 54,
  });

  pushSequentialGroups(groups, {
    startSeat: 81,
    endSeat: Math.min(120, total),
    startX: 92,
    startY: 640,
    groupsPerRow: 5,
    groupSize: 4,
    cols: 2,
    colGap: 142,
    rowGap: 126,
    aisleAfterCol: 3,
    aisleX: 54,
  });

  pushSequentialGroups(groups, {
    startSeat: 121,
    endSeat: Math.min(180, total),
    startX: 92,
    startY: 930,
    groupsPerRow: 5,
    groupSize: 4,
    cols: 2,
    colGap: 142,
    rowGap: 126,
    aisleAfterCol: 3,
    aisleX: 54,
  });

  return { width: 960, height: 1380, groups };
}

function getStatusText(status) {
  const statusMap = {
    empty: "비어있음",
    away: "외출",
    reserved: "예약됨",
    mine: "내가 예약함",
  };

  return statusMap[status] || status;
}

async function handleReserve() {
  if (!selectedSeatId) return;

  try {
    await api.reserveSeat(currentRoomId, selectedSeatId);
    selectedSeatId = null;
    await refreshApp();
    expandSheet();
  } catch (error) {
    alert(error.message);
    await refreshApp();
  }
}

async function renderReservation() {
  const reservation = await api.getMyReservation();
  activeReservation = reservation;
  hasActiveReservation = Boolean(reservation);

  if (!reservation) {
    myRoomTitle.textContent = "예약 좌석";
    mySeatTitle.textContent = "예약된 좌석이 없습니다";
    mySeatStatus.textContent = "대기";
    mySeatStatus.classList.remove("away");
    remainTime.textContent = "00:00:00";
    timeLabel.textContent = "남은 시간";
    updateTimerRing(0, RESERVATION_SECONDS);

    returnButton.disabled = true;
    leaveButton.disabled = true;
    leaveButton.textContent = "외출하기";
    extendButton.disabled = true;
    extendButton.textContent = "연장하기";
    extendButton.classList.remove("return-away-mode");
    extensionGuide.textContent = "남은 시간이 1시간 이하일 때 연장할 수 있습니다.";
    manageActions.classList.remove("away-mode");
    bottomSheet.classList.remove("away-mode");

    reservationBar.classList.remove("hidden");
    managePanel.classList.add("hidden");

    if (isSheetExpanded) collapseSheet();

    stopTimer();
    isAutoReturning = false;
    updateReservationBarForCollapsedState();
    updateSheetToggle();
    renderSeats();
    return;
  }

  const room = ROOMS.find((item) => item.id === reservation.roomId);
  const isAway = reservation.status === "away";
  bottomSheet.classList.toggle("away-mode", isAway);

  myRoomTitle.textContent = room.name;
  mySeatTitle.textContent = isAway ? `${reservation.seatId}번 외출 중` : `${reservation.seatId}번 예약 중`;
  mySeatStatus.textContent = isAway ? "외출중" : "예약중";
  mySeatStatus.classList.toggle("away", isAway);

  returnButton.disabled = false;

  if (isAway) {
    leaveButton.disabled = true;
    leaveButton.textContent = "외출 중";
    extendButton.disabled = false;
    extendButton.textContent = "외출 복귀하기";
    extendButton.classList.add("return-away-mode");
    extensionGuide.textContent = "복귀하면 남은 예약 시간 화면으로 돌아갑니다.";
    manageActions.classList.add("away-mode");
  } else if (reservation.hasUsedAway === true) {
    leaveButton.disabled = true;
    leaveButton.textContent = "외출 사용 완료";
    extendButton.textContent = "연장하기";
    extendButton.classList.remove("return-away-mode");
    extensionGuide.textContent = "남은 시간이 1시간 이하일 때 연장할 수 있습니다.";
    manageActions.classList.remove("away-mode");
  } else {
    leaveButton.disabled = false;
    leaveButton.textContent = "외출하기";
    extendButton.textContent = "연장하기";
    extendButton.classList.remove("return-away-mode");
    extensionGuide.textContent = "남은 시간이 1시간 이하일 때 연장할 수 있습니다.";
    manageActions.classList.remove("away-mode");
  }

  if (isSheetExpanded) {
    reservationBar.classList.add("hidden");
    managePanel.classList.remove("hidden");
  } else {
    reservationBar.classList.remove("hidden");
    managePanel.classList.add("hidden");
    updateReservationBarForCollapsedState();
  }

  updateSheetToggle();
  if (reservation.tempWarning) {
    setMessage(
      manageMessage,
      "⚠️ 20분 이상 자리를 비운 것으로 감지되었습니다. 10분 내로 돌아오지 않으면 자동 퇴실 처리됩니다.",
      "error"
    );
  } else {
    setMessage(manageMessage, "");
  }
  updateTimer();
  startTimer();
  renderSeats();
}

function updateReservationBarForCollapsedState() {
  if (!hasActiveReservation || !activeReservation) {
    const room = getCurrentRoom();
    sheetRoomName.textContent = room.name;
    sheetSeatName.textContent = selectedSeatId ? `${selectedSeatId}번` : "좌석을 선택해주세요";
    reserveButton.textContent = "예약하기";
    reserveButton.disabled = !selectedSeatId;
    return;
  }

  const room = ROOMS.find((item) => item.id === activeReservation.roomId);
  const isAway = activeReservation.status === "away";

  sheetRoomName.textContent = room.name;
  sheetSeatName.textContent = isAway
    ? `${activeReservation.seatId}번 외출 중`
    : `${activeReservation.seatId}번 예약 중`;
  reserveButton.textContent = isAway ? "외출중" : "예약중";
  reserveButton.disabled = true;
}

function expandSheet() {
  if (!hasActiveReservation) return;

  isSheetExpanded = true;
  bottomSheet.classList.add("expanded");
  reservationBar.classList.add("hidden");
  managePanel.classList.remove("hidden");
  updateSheetToggle();
}

function collapseSheet() {
  isSheetExpanded = false;
  bottomSheet.classList.remove("expanded");
  managePanel.classList.add("hidden");
  reservationBar.classList.remove("hidden");
  updateReservationBarForCollapsedState();
  updateSheetToggle();
}

function updateSheetToggle() {
  sheetToggleButton.disabled = !hasActiveReservation;
  sheetToggleButton.setAttribute(
    "aria-label",
    isSheetExpanded ? "좌석 선택 화면 보기" : "좌석 관리 화면 열기"
  );
}


async function handleReservationExpired() {
  if (isAutoReturning || !activeReservation) return;

  isAutoReturning = true;

  try {
    await api.returnSeat();
    alert("예약 시간이 종료되어 좌석이 자동 반납되었습니다.");
    await refreshApp();
    collapseSheet();
  } catch (error) {
    console.error(error);
    setMessage(manageMessage, error.message || "자동 반납 중 오류가 발생했습니다.", "error");
  } finally {
    isAutoReturning = false;
  }
}

function startTimer() {
  stopTimer();
  timerId = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

function updateTimer() {
  const reservation = activeReservation;

  if (!reservation) {
    bottomSheet.classList.remove("away-mode");
    updateTimerRing(0, RESERVATION_SECONDS);
    updateAwayTimerRing(0, AWAY_SECONDS);
    return;
  }

  const isAway = reservation.status === "away";
  bottomSheet.classList.toggle("away-mode", isAway);

  // 열람실 남은 시간 — 외출 중에도 계속 카운트다운
  const seconds = Math.max(0, Math.floor((reservation.reservedUntil.toDate().getTime() - Date.now()) / 1000));
  timeLabel.textContent = "남은 시간";
  remainTime.textContent = formatTime(seconds);
  updateTimerRing(seconds, RESERVATION_SECONDS);

  // 외출 타이머 — 외출 중일 때만 표시
  if (isAway) {
    awayTimerRing.classList.remove("hidden");
    const awaySeconds = Math.max(0, Math.floor((reservation.awayUntil.toDate().getTime() - Date.now()) / 1000));
    awayRemainTime.textContent = formatTime(awaySeconds);
    updateAwayTimerRing(awaySeconds, AWAY_SECONDS);
  } else {
    awayTimerRing.classList.add("hidden");
    updateAwayTimerRing(0, AWAY_SECONDS);
  }

  if (isAway) {
    extendButton.disabled = false;
    extendButton.textContent = "외출 복귀하기";
    extendButton.classList.add("return-away-mode");
  } else {
    extendButton.disabled = seconds > EXTEND_AVAILABLE_SECONDS;
    extendButton.textContent = "연장하기";
    extendButton.classList.remove("return-away-mode");
  }

  if (seconds <= 0) {
    handleReservationExpired();
  }
}

function updateTimerRing(remainingSeconds, totalSeconds) {
  if (!timerProgress) return;

  const safeTotal = Math.max(totalSeconds, 1);
  const ratio = Math.max(0, Math.min(1, remainingSeconds / safeTotal));
  const offset = TIMER_CIRCUMFERENCE * (1 - ratio);

  timerProgress.style.strokeDasharray = `${TIMER_CIRCUMFERENCE}`;
  timerProgress.style.strokeDashoffset = `${-offset}`;
}

function updateAwayTimerRing(remainingSeconds, totalSeconds) {
  if (!awayTimerProgress) return;

  const safeTotal = Math.max(totalSeconds, 1);
  const ratio = Math.max(0, Math.min(1, remainingSeconds / safeTotal));
  const offset = TIMER_CIRCUMFERENCE * (1 - ratio);

  awayTimerProgress.style.strokeDasharray = `${TIMER_CIRCUMFERENCE}`;
  awayTimerProgress.style.strokeDashoffset = `${-offset}`;
}

function formatTime(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

function openReturnModal() {
  confirmModal.classList.remove("hidden");
}

function closeReturnModal() {
  confirmModal.classList.add("hidden");
}

function openAwayModal() {
  awayModal.classList.remove("hidden");
}

function closeAwayModal() {
  awayModal.classList.add("hidden");
}

function openReturnAwayModal() {
  returnAwayModal.classList.remove("hidden");
}

function closeReturnAwayModal() {
  returnAwayModal.classList.add("hidden");
}


function enableSheetDrag(sheetElement) {
  let isDown = false;
  let startY = 0;
  let currentY = 0;
  let startExpanded = false;
  const dragThreshold = 44;

  function isInteractiveTarget(target) {
    if (!(target instanceof Element)) return false;

    return Boolean(
      target.closest("button") ||
      target.closest("input") ||
      target.closest("textarea") ||
      target.closest("select") ||
      target.closest("a")
    );
  }

  sheetElement.addEventListener("pointerdown", (event) => {
    if (!hasActiveReservation) return;
    if (isInteractiveTarget(event.target)) return;

    isDown = true;
    startY = event.clientY;
    currentY = event.clientY;
    startExpanded = isSheetExpanded;
    sheetElement.classList.add("sheet-dragging");
    sheetElement.setPointerCapture(event.pointerId);
  });

  sheetElement.addEventListener("pointermove", (event) => {
    if (!isDown) return;
    currentY = event.clientY;
  });

  function endSheetDrag() {
    if (!isDown) return;

    const deltaY = currentY - startY;
    isDown = false;
    sheetElement.classList.remove("sheet-dragging");

    // 좌석 선택 화면에서 하단바를 위로 드래그하면 관리 화면 열기
    if (!startExpanded && deltaY < -dragThreshold) {
      expandSheet();
      return;
    }

    // 좌석 관리 화면에서 버튼이 아닌 영역을 아래로 드래그하면 좌석 선택 화면으로 돌아가기
    if (startExpanded && deltaY > dragThreshold) {
      collapseSheet();
    }
  }

  sheetElement.addEventListener("pointerup", endSheetDrag);
  sheetElement.addEventListener("pointercancel", endSheetDrag);
}

function enableDragScroll(element) {
  let isDown = false;
  let startX = 0;
  let startY = 0;
  let scrollLeft = 0;
  let scrollTop = 0;
  let hasDragged = false;
  let pressedSeatButton = null;
  const dragThreshold = 6;

  element.addEventListener("pointerdown", (event) => {
    // 좌석 버튼 위에서 눌러도 드래그 스크롤이 시작되도록 합니다.
    // 동시에, 거의 움직이지 않고 손을 떼면 좌석 선택으로 처리합니다.
    isDown = true;
    hasDragged = false;
    pressedSeatButton = event.target.closest(".seat");
    element.dataset.dragged = "false";
    element.classList.add("dragging");
    startX = event.clientX;
    startY = event.clientY;
    scrollLeft = element.scrollLeft;
    scrollTop = element.scrollTop;
    element.setPointerCapture(event.pointerId);
  });

  element.addEventListener("pointermove", (event) => {
    if (!isDown) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) {
      hasDragged = true;
      element.dataset.dragged = "true";
    }

    element.scrollLeft = scrollLeft - dx;
    element.scrollTop = scrollTop - dy;
  });

  function endDrag() {
    const shouldSelectSeat = !hasDragged && pressedSeatButton;

    isDown = false;
    element.classList.remove("dragging");
    element.dataset.dragged = hasDragged ? "true" : "false";

    if (shouldSelectSeat) {
      // pointer capture 때문에 모바일에서 기본 click이 사라지는 경우가 있어 직접 click을 실행합니다.
      pressedSeatButton.click();
    }

    pressedSeatButton = null;

    if (hasDragged) {
      // 드래그 직후 발생할 수 있는 click은 잠깐 막습니다.
      window.setTimeout(() => {
        element.dataset.dragged = "false";
      }, 120);
    }
  }

  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", () => {
    isDown = false;
    pressedSeatButton = null;
    element.dataset.dragged = "false";
    element.classList.remove("dragging");
  });
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const id = document.querySelector("#loginId").value;
    const password = document.querySelector("#loginPassword").value;

    try {
      setMessage(loginMessage, "로그인 중입니다.");
      await api.login(id, password);
      setMessage(loginMessage, "");
    } catch (error) {
      setMessage(loginMessage, error.message, "error");
    }
  });
}

if (signupForm) {
  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const id = document.querySelector("#signupId").value;
    const password = document.querySelector("#signupPassword").value;
    const passwordCheck = document.querySelector("#signupPasswordCheck").value;

    if (password !== passwordCheck) {
      setMessage(signupMessage, "비밀번호가 서로 다릅니다.", "error");
      return;
    }

    try {
      setMessage(signupMessage, "회원가입 중입니다.");
      await api.signup(id, password);
      setMessage(signupMessage, "회원가입이 완료되었습니다.", "success");
      signupForm.reset();
    } catch (error) {
      setMessage(signupMessage, error.message, "error");
    }
  });
}

document.querySelector("#goSignupButton")?.addEventListener("click", () => {
  setMessage(loginMessage, "");
  showScreen("signup");
});

document.querySelector("#backToLoginButton")?.addEventListener("click", () => {
  showScreen("login");
});

document.querySelector("#logoutButton")?.addEventListener("click", async () => {
  await api.logout();
  stopTimer();
  setMessage(loginMessage, "");
});

reserveButton.addEventListener("click", handleReserve);
returnButton.addEventListener("click", openReturnModal);

sheetToggleButton.addEventListener("click", () => {
  if (!hasActiveReservation) return;

  if (isSheetExpanded) {
    collapseSheet();
  } else {
    expandSheet();
  }
});

document.querySelector("#cancelReturnButton")?.addEventListener("click", closeReturnModal);

document.querySelector("#confirmReturnButton")?.addEventListener("click", async () => {
  try {
    await api.returnSeat();
    closeReturnModal();
    await refreshApp();
    collapseSheet();
  } catch (error) {
    setMessage(manageMessage, error.message, "error");
  }
});

leaveButton.addEventListener("click", () => {
  if (!activeReservation) return;

  if (activeReservation.status === "away") {
    openReturnAwayModal();
    return;
  }

  if (activeReservation.hasUsedAway === true) {
    setMessage(manageMessage, "외출은 예약 한 번당 한 번만 사용할 수 있습니다.", "error");
    return;
  }

  openAwayModal();
});

document.querySelector("#cancelAwayButton")?.addEventListener("click", closeAwayModal);

document.querySelector("#confirmAwayButton")?.addEventListener("click", async () => {
  try {
    await api.markAway();
    closeAwayModal();
    await refreshApp();
    collapseSheet();
  } catch (error) {
    closeAwayModal();
    setMessage(manageMessage, error.message, "error");
  }
});

document.querySelector("#cancelReturnAwayButton")?.addEventListener("click", closeReturnAwayModal);

document.querySelector("#confirmReturnAwayButton")?.addEventListener("click", async () => {
  try {
    await api.returnFromAway();
    closeReturnAwayModal();
    await refreshApp();
    expandSheet();
  } catch (error) {
    closeReturnAwayModal();
    setMessage(manageMessage, error.message, "error");
  }
});

extendButton.addEventListener("click", async () => {
  try {
    if (activeReservation?.status === "away") {
      await api.returnFromAway();
      await refreshApp();
      expandSheet();
      return;
    }

    await api.extendReservation();
    await refreshApp();
    expandSheet();
  } catch (error) {
    setMessage(manageMessage, error.message, "error");
    alert(error.message);
  }
});

enableDragScroll(mapViewport);
enableSheetDrag(bottomSheet);

onAuthStateChanged(auth, async (user) => {
  try {
    if (user) {
      await setupAppForUser();
    } else {
      selectedSeatId = null;
      seatsByRoom = {};
      showScreen("login");
    }
  } catch (error) {
    console.error(error);
    alert(`Firebase 연결 중 오류가 발생했습니다: ${error.message}`);
    showScreen("login");
  }
});
