let calendar;                 // 전역 변수로 한 번만 선언
let currentCity = "Asia/Seoul";
let editingEventIndex = null;     // 모달에서 편집 중인 이벤트 인덱스
let editingBaseDate = null;       // 편집 기준 날짜 (YYYY-MM-DD)

// 지정한 타임존에서의 벽시(wall time)를 UTC ISO 문자열로 변환
function convertWallTimeToUTCISO(dateYYYYMMDD, hhmm, timeZone) {
  const [year, month, day] = dateYYYYMMDD.split("-").map((v) => parseInt(v, 10));
  const [hour, minute] = hhmm.split(":").map((v) => parseInt(v, 10));

  // 시작값: 해당 날짜/시간을 UTC로 간주한 시각
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  function formattedParts(ms) {
    const s = fmt.format(new Date(ms)); // e.g. 2025-09-02, 10:00
    const [d, t] = s.split(", ");
    const [yy, mm, dd] = d.split("-").map((v) => parseInt(v, 10));
    const [hh, mi] = t.split(":").map((v) => parseInt(v, 10));
    return { yy, mm, dd, hh, mi };
  }

  // 반복적으로 원하는 벽시와 일치하도록 보정 (DST 경계 포함)
  for (let i = 0; i < 3; i++) {
    const p = formattedParts(utcMs);
    const target = {
      yy: year,
      mm: month,
      dd: day,
      hh: hour,
      mi: minute
    };
    const deltaMinutes = (target.hh - p.hh) * 60 + (target.mi - p.mi) + (target.dd - p.dd) * 24 * 60;
    if (deltaMinutes === 0 && target.yy === p.yy && target.mm === p.mm) break;
    utcMs += deltaMinutes * 60 * 1000;
  }

  return new Date(utcMs).toISOString();
}

// 시간 파싱 함수: 범위/단일 시간 모두 지원
function parseTimeAndTitle(input) {
  const text = input.trim();
  const normalized = text
    .replace(/[~～〜]/g, '~')
    .replace(/\s+/g, ' ')
    .trim();

  // 1) 범위: HH[:mm] ~ HH[:mm] [Title]  (한글 '시' 없어도 동작)
  let range = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*[~\-]\s*(\d{1,2})(?::(\d{2}))?\s*(.*)$/);
  if (range) {
    const sh = parseInt(range[1], 10);
    const sm = range[2] ? parseInt(range[2], 10) : 0;
    const ehRaw = parseInt(range[3], 10);
    const em = range[4] ? parseInt(range[4], 10) : sm; // 분 생략 시 시작 분과 동일
    const title = (range[5] || '').trim();
    if (sh >= 0 && sh <= 23 && ehRaw >= 0 && ehRaw <= 24 && sm >= 0 && sm <= 59 && em >= 0 && em <= 59) {
      const eh = ehRaw === 24 ? 0 : ehRaw; // 24시는 00시로 정규화
      return {
        startTime: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
        endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
        title: title || text // 제목이 비어도 원문 유지
      };
    }
  }
  // 1-보강) '시' 표기가 섞인 범위도 허용: [HH[:mm]]시 ~ [HH[:mm]]시 [Title]
  range = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*시\s*[~\-]\s*(\d{1,2})(?::(\d{2}))?\s*시?\s*(.*)$/);
  if (range) {
    const sh = parseInt(range[1], 10);
    const sm = range[2] ? parseInt(range[2], 10) : 0;
    const ehRaw = parseInt(range[3], 10);
    const em = range[4] ? parseInt(range[4], 10) : sm;
    const title = (range[5] || '').trim();
    if (sh >= 0 && sh <= 23 && ehRaw >= 0 && ehRaw <= 24 && sm >= 0 && sm <= 59 && em >= 0 && em <= 59) {
      const eh = ehRaw === 24 ? 0 : ehRaw;
      return {
        startTime: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
        endTime: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
        title: title || text
      };
    }
  }

  // 2) 단일: HH[:mm](시) Title → 기본 1시간
  const single = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*시?\s*(.*)$/);
  if (single) {
    const h = parseInt(single[1], 10);
    const m = single[2] ? parseInt(single[2], 10) : 0;
    const title = (single[3] || '').trim();
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      const endH = (h + 1) % 24;
      return {
        startTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        endTime: `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        title: title || text
      };
    }
  }

  // 3) 실패 시 기본 시간 사용
  const defaultTime = document.getElementById("defaultTime").value;
  return { startTime: defaultTime, endTime: defaultTime, title: text };
}

// 스토리지에서 스케줄 가져와서 이벤트 변환
function loadSchedules(callback) {
  chrome.storage.local.get({ schedules: [] }, (result) => {
    const events = result.schedules.map((s, index) => {
      // 기존 데이터 호환성을 위한 처리
      if (s.utcTime) {
        // 기존 형식 (단일 시간)
        const utcDate = new Date(s.utcTime);
        const cityTime = new Intl.DateTimeFormat("sv-SE", {
          timeZone: currentCity,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(utcDate);
        const isoTime = cityTime.replace(" ", "T") + ":00";

        return {
          id: index.toString(),
          title: s.title,
          start: isoTime
        };
      } else {
        // 새로운 형식 (시작/종료 시간)
        const startUtcDate = new Date(s.startUtcTime);
        const endUtcDate = new Date(s.endUtcTime);
        
        const startCityTime = new Intl.DateTimeFormat("sv-SE", {
          timeZone: currentCity,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(startUtcDate);
        
        const endCityTime = new Intl.DateTimeFormat("sv-SE", {
          timeZone: currentCity,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(endUtcDate);

        const startIsoTime = startCityTime.replace(" ", "T") + ":00";
        const endIsoTime = endCityTime.replace(" ", "T") + ":00";

        return {
          id: index.toString(),
          title: s.title,
          start: startIsoTime,
          end: endIsoTime
        };
      }
    });
    callback(events);
  });
}

// 스케줄 저장
function addSchedule(title, startDateStr, endDateStr) {
  const startUtcTime = convertWallTimeToUTCISO(startDateStr.slice(0,10), startDateStr.slice(11,16), currentCity);
  const endUtcTime = convertWallTimeToUTCISO(endDateStr.slice(0,10), endDateStr.slice(11,16), currentCity);

  chrome.storage.local.get({ schedules: [] }, (result) => {
    const schedules = result.schedules;
    schedules.push({ 
      title, 
      startUtcTime, 
      endUtcTime 
    });
    chrome.storage.local.set({ schedules }, () => {
      renderCalendar();
    });
  });
}

// 편집 저장 - 추후 author까지 저장. 
function updateScheduleByIndex(index, title, startDateStr, endDateStr) {
  const startUtcTime = convertWallTimeToUTCISO(startDateStr.slice(0,10), startDateStr.slice(11,16), currentCity);
  const endUtcTime = convertWallTimeToUTCISO(endDateStr.slice(0,10), endDateStr.slice(11,16), currentCity);

  chrome.storage.local.get({ schedules: [] }, (result) => {
    const schedules = result.schedules;
    if (!schedules[index]) return;
    schedules[index] = { title, startUtcTime, endUtcTime };
    chrome.storage.local.set({ schedules }, () => {
      renderCalendar();
    });
  });
}

// 삭제
function deleteScheduleByIndex(index) {
  chrome.storage.local.get({ schedules: [] }, (result) => {
    const schedules = result.schedules;
    if (!schedules[index]) return;
    schedules.splice(index, 1);
    chrome.storage.local.set({ schedules }, () => {
      renderCalendar();
    });
  });
}

// 날짜 문자열에 일수 더하기 (YYYY-MM-DD)
function addDaysToDateString(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}

// 모달 열기/닫기
function openEventModal(index, baseDate, titlePrefill) {
  editingEventIndex = index;
  editingBaseDate = baseDate;
  const modal = document.getElementById("eventModal");
  const input = document.getElementById("editInput");
  const hint = document.getElementById("modalHint");
  input.value = titlePrefill || "";
  modal.style.display = "flex";
}

function closeEventModal() {
  const modal = document.getElementById("eventModal");
  modal.style.display = "none";
  editingEventIndex = null;
  editingBaseDate = null;
}

// 달력 렌더링
function renderCalendar() {
  loadSchedules((events) => {
    if (calendar) {
      calendar.destroy();  // 기존 달력 제거
    }

    const calendarEl = document.getElementById("calendar");

    // 전역 calendar 변수에 새 달력 객체 할당
    calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: "dayGridMonth",
      selectable: true,
      events: events,
      eventTimeFormat: {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      },
      dateClick: function(info) {
        const input = prompt("Enter schedule");
        if (input) {
          const parsed = parseTimeAndTitle(input);
          const startDateStr = info.dateStr + "T" + parsed.startTime;
          let endDate = info.dateStr;
          const startHour = parseInt(parsed.startTime.split(":")[0]);
          const endHour = parseInt(parsed.endTime.split(":")[0]);
          if (endHour < startHour) {
            endDate = addDaysToDateString(info.dateStr, 1);
          }
          const endDateStr = endDate + "T" + parsed.endTime;
          addSchedule(parsed.title, startDateStr, endDateStr);
        }
      },
      eventClick: function(info) {
        // 선택한 이벤트의 인덱스와 기준 날짜 추출
        const index = parseInt(info.event.id);
        const baseDate = info.event.startStr.slice(0,10);
        // 편집 입력란은 현재 제목만 채운다 (형식은 사용자 자유)
        openEventModal(index, baseDate, info.event.title);
      }
    });

    calendar.render();
  });
}

// 타임존 선택 변경 시 다시 렌더링
document.getElementById("city").addEventListener("change", (e) => {
  currentCity = e.target.value;
  renderCalendar();
});

// DOM 로드 완료 시 달력 초기화
document.addEventListener("DOMContentLoaded", renderCalendar);

// 모달 버튼 이벤트 리스너
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("modalClose");
  const cancelBtn = document.getElementById("cancelEvent");
  const saveBtn = document.getElementById("saveEvent");
  const deleteBtn = document.getElementById("deleteEvent");

  if (closeBtn) closeBtn.addEventListener("click", closeEventModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeEventModal);
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const value = document.getElementById("editInput").value.trim();
    if (!value || editingEventIndex === null || !editingBaseDate) {
      closeEventModal();
      return;
    }
    const parsed = parseTimeAndTitle(value);
    const startDateStr = editingBaseDate + "T" + parsed.startTime;
    let endDate = editingBaseDate;
    const startHour = parseInt(parsed.startTime.split(":")[0]);
    const endHour = parseInt(parsed.endTime.split(":")[0]);
    if (endHour < startHour) {
      endDate = addDaysToDateString(editingBaseDate, 1);
    }
    const endDateStr = endDate + "T" + parsed.endTime;
    updateScheduleByIndex(editingEventIndex, parsed.title, startDateStr, endDateStr);
    closeEventModal();
  });
  if (deleteBtn) deleteBtn.addEventListener("click", () => {
    if (editingEventIndex === null) {
      closeEventModal();
      return;
    }
    deleteScheduleByIndex(editingEventIndex);
    closeEventModal();
  });
  // ESC/Enter 키 처리: ESC는 닫기, Enter는 저장
  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("eventModal");
    const isOpen = modal && modal.style.display !== "none";
    if (!isOpen) return;

    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      closeEventModal();
    }
    if (e.key === "Enter") {
      e.stopPropagation();
      e.preventDefault();
      const saveBtnEl = document.getElementById("saveEvent");
      if (saveBtnEl) saveBtnEl.click();
    }
  });
});
