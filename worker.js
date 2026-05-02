/**
 * KANBAN TODO LIST (14KO Compliant)
 * Features: Multi-board, Lists, Cards, Drag & Drop
 */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    // Normalize path: strip /todo prefix if present
    let path = url.pathname;
    if (path.startsWith('/todo')) {
      path = path.substring(5) || '/';
    }

    // SESSION MANAGEMENT
    const cookie = req.headers.get('Cookie');
    const sessionId = cookie ? cookie.split(';').find(c => c.trim().startsWith('sess='))?.split('=')[1] : null;
    let user = null;
    if (sessionId) {
      user = await env.AUTH_DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').bind(sessionId, Date.now()).first();
      if (user) {
        const dbUser = await env.AUTH_DB.prepare('SELECT role FROM users WHERE username = ?').bind(user.username).first();
        user.role = dbUser?.role || 'viewer';
      }
    }

    // PROTECTED ROUTES — redirect to central auth if not logged in
    if (!user) {
      const redirectUrl = `/auth/login?redirect=${encodeURIComponent(url.pathname)}`;
      return new Response(null, { status: 302, headers: { 'Location': redirectUrl } });
    }

    // API: BOARD
    if (path === '/api/board/create' && method === 'POST') {
      const fd = await req.formData();
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO boards (id, username, name, created_at) VALUES (?, ?, ?, ?)').bind(id, user.username, fd.get('name'), Date.now()).run();
      return new Response(JSON.stringify({ id }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/api/board/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM boards WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    // API: BLOCUS CALENDAR
    if (path === '/api/blocus/create' && method === 'POST') {
      const fd = await req.formData();
      const name = (fd.get('name') || '').toString().trim();
      const startDate = (fd.get('startDate') || '').toString();
      const endDate = (fd.get('endDate') || '').toString();
      const parsedStart = parseIsoDate(startDate);
      const parsedEnd = parseIsoDate(endDate);

      if (!name) return new Response('Calendar name is required.', { status: 400 });
      if (!parsedStart || !parsedEnd) return new Response('Invalid date range.', { status: 400 });
      if (!isWithinFourMonths(parsedStart, parsedEnd)) return new Response('Blocus period must be between 1 day and 4 months.', { status: 400 });

      let courses;
      try {
        courses = JSON.parse((fd.get('courses') || '[]').toString());
      } catch {
        return new Response('Invalid courses payload.', { status: 400 });
      }

      if (!Array.isArray(courses) || courses.length === 0) {
        return new Response('Add at least one course.', { status: 400 });
      }

      const normalizedCourses = normalizeBlocusCourses(courses);
      if (normalizedCourses.length === 0) {
        return new Response('Add at least one valid course.', { status: 400 });
      }

      const createdAt = Date.now();
      const blocusId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO blocus_boards (id, username, name, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(blocusId, user.username, name, startDate, endDate, createdAt).run();

      for (let i = 0; i < normalizedCourses.length; i++) {
        const course = normalizedCourses[i];
        const courseId = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO blocus_courses (id, blocus_id, username, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(courseId, blocusId, user.username, course.name, course.color, i, createdAt).run();

        for (let j = 0; j < course.sections.length; j++) {
          await env.DB.prepare(
            'INSERT INTO blocus_course_sections (id, blocus_id, course_id, username, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), blocusId, courseId, user.username, course.sections[j], j, createdAt).run();
        }
      }

      return new Response(JSON.stringify({ id: blocusId }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/api/blocus/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM blocus_boards WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/blocus/slot/update' && method === 'POST') {
      const fd = await req.formData();
      const blocusId = (fd.get('blocusId') || '').toString();
      const day = (fd.get('day') || '').toString();
      const period = (fd.get('period') || '').toString();
      const isExam = (fd.get('isExam') || '').toString() === '1';
      const examNote = (fd.get('examNote') || '').toString().trim();
      const examStartRaw = (fd.get('examStartTime') || '').toString();
      const examEndRaw = (fd.get('examEndTime') || '').toString();
      const clientUpdatedAtRaw = (fd.get('clientUpdatedAt') || '').toString();
      let courseId = (fd.get('courseId') || '').toString();
      let sectionId = (fd.get('sectionId') || '').toString();
      const examStartTime = normalizeExamTime(examStartRaw);
      const examEndTime = normalizeExamTime(examEndRaw);
      const clientUpdatedAt = Number(clientUpdatedAtRaw);
      const updateTimestamp = Number.isFinite(clientUpdatedAt) && clientUpdatedAt > 0
        ? Math.floor(clientUpdatedAt)
        : Date.now();

      if (!blocusId || !parseIsoDate(day)) return new Response('Invalid slot date.', { status: 400 });
      if (!['morning', 'afternoon'].includes(period)) return new Response('Invalid slot period.', { status: 400 });
      if (examStartTime === null || examEndTime === null) return new Response('Invalid exam time format. Use 24h HH:MM.', { status: 400 });

      const blocus = await env.DB.prepare(
        'SELECT id, start_date, end_date FROM blocus_boards WHERE id = ? AND username = ?'
      ).bind(blocusId, user.username).first();
      if (!blocus) return new Response('Calendar not found.', { status: 404 });
      if (!isDateInRange(day, blocus.start_date, blocus.end_date)) return new Response('Date is out of range for this calendar.', { status: 400 });

      const { results: rowsBeforeSave } = await env.DB.prepare(
        `SELECT period, course_id, section_id, is_exam, exam_note, exam_start_time, exam_end_time
         FROM blocus_slots
         WHERE blocus_id = ? AND day = ? AND username = ?`
      ).bind(blocusId, day, user.username).all();
      const beforeMorning = rowsBeforeSave.find(row => row.period === 'morning');
      const beforeAfternoon = rowsBeforeSave.find(row => row.period === 'afternoon');
      const wasMirroredAllDay = Boolean(
        beforeMorning &&
        beforeAfternoon &&
        Number(beforeMorning.is_exam) === 1 &&
        Number(beforeAfternoon.is_exam) === 1 &&
        (beforeMorning.course_id || '') === (beforeAfternoon.course_id || '') &&
        (beforeMorning.section_id || '') === (beforeAfternoon.section_id || '') &&
        (beforeMorning.exam_note || '') === (beforeAfternoon.exam_note || '') &&
        (normalizeExamTime(beforeMorning.exam_start_time || '') || '') &&
        (normalizeExamTime(beforeMorning.exam_end_time || '') || '') &&
        (normalizeExamTime(beforeMorning.exam_start_time || '') || '') === (normalizeExamTime(beforeAfternoon.exam_start_time || '') || '') &&
        (normalizeExamTime(beforeMorning.exam_end_time || '') || '') === (normalizeExamTime(beforeAfternoon.exam_end_time || '') || '')
      );

      if (sectionId) {
        const section = await env.DB.prepare(
          'SELECT s.id, s.course_id FROM blocus_course_sections s INNER JOIN blocus_courses c ON c.id = s.course_id WHERE s.id = ? AND s.blocus_id = ? AND c.username = ?'
        ).bind(sectionId, blocusId, user.username).first();
        if (!section) return new Response('Invalid course section.', { status: 400 });
        courseId = section.course_id;
      } else if (courseId) {
        const course = await env.DB.prepare(
          'SELECT id FROM blocus_courses WHERE id = ? AND blocus_id = ? AND username = ?'
        ).bind(courseId, blocusId, user.username).first();
        if (!course) return new Response('Invalid course.', { status: 400 });
      } else {
        courseId = null;
        sectionId = null;
      }

      if (!isExam) {
        if (!courseId && !sectionId && !examNote && !examStartTime && !examEndTime) {
          if (wasMirroredAllDay) {
            await env.DB.prepare(
              'DELETE FROM blocus_slots WHERE blocus_id = ? AND day = ? AND period IN (?, ?) AND username = ?'
            ).bind(blocusId, day, 'morning', 'afternoon', user.username).run();
          } else {
            await env.DB.prepare(
              'DELETE FROM blocus_slots WHERE blocus_id = ? AND day = ? AND period = ? AND username = ?'
            ).bind(blocusId, day, period, user.username).run();
          }
          const { results: rowsAfterDelete } = await env.DB.prepare(
            `SELECT period, course_id, section_id, is_exam, exam_note, exam_start_time, exam_end_time
             FROM blocus_slots
             WHERE blocus_id = ? AND day = ? AND username = ?`
          ).bind(blocusId, day, user.username).all();
          const slots = {
            morning: { period: 'morning', courseId: '', sectionId: '', isExam: 0, examNote: '', examStartTime: '', examEndTime: '' },
            afternoon: { period: 'afternoon', courseId: '', sectionId: '', isExam: 0, examNote: '', examStartTime: '', examEndTime: '' }
          };
          rowsAfterDelete.forEach(row => {
            if (!slots[row.period]) return;
            slots[row.period] = {
              period: row.period,
              courseId: row.course_id || '',
              sectionId: row.section_id || '',
              isExam: Number(row.is_exam) === 1 ? 1 : 0,
              examNote: row.exam_note || '',
              examStartTime: row.exam_start_time || '',
              examEndTime: row.exam_end_time || ''
            };
          });
          return new Response(JSON.stringify({ day, slots, appliedPeriods: [] }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      const toMinutes = (time) => {
        if (!time) return null;
        const [hhRaw, mmRaw] = String(time).split(':');
        const hh = Number(hhRaw);
        const mm = Number(mmRaw);
        if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
        if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
        return (hh * 60) + mm;
      };

      let targetPeriods = [period];
      if (isExam && examStartTime && examEndTime) {
        const startMinutes = toMinutes(examStartTime);
        const endMinutes = toMinutes(examEndTime);
        if (startMinutes !== null && endMinutes !== null) {
          const noon = 12 * 60;
          if (startMinutes >= noon && endMinutes >= noon) {
            targetPeriods = ['afternoon'];
          } else if (startMinutes < noon && endMinutes <= noon) {
            targetPeriods = ['morning'];
          } else {
            targetPeriods = ['morning', 'afternoon'];
          }
        }
      }

      const upsertSlotForPeriod = async (targetPeriod) => {
        await env.DB.prepare(
          `INSERT INTO blocus_slots (id, blocus_id, username, day, period, course_id, section_id, is_exam, exam_note, exam_start_time, exam_end_time, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(blocus_id, day, period) DO UPDATE SET
             course_id = excluded.course_id,
             section_id = excluded.section_id,
             is_exam = excluded.is_exam,
             exam_note = excluded.exam_note,
             exam_start_time = excluded.exam_start_time,
             exam_end_time = excluded.exam_end_time,
             updated_at = excluded.updated_at
           WHERE excluded.updated_at >= blocus_slots.updated_at`
        ).bind(
          crypto.randomUUID(),
          blocusId,
          user.username,
          day,
          targetPeriod,
          courseId || null,
          sectionId || null,
          isExam ? 1 : 0,
          isExam ? examNote : '',
          isExam ? (examStartTime || '') : '',
          isExam ? (examEndTime || '') : '',
          updateTimestamp
        ).run();
      };

      for (const targetPeriod of targetPeriods) {
        await upsertSlotForPeriod(targetPeriod);
      }

      const periodsToDelete = [];
      if (wasMirroredAllDay) {
        ['morning', 'afternoon'].forEach(periodName => {
          if (!targetPeriods.includes(periodName)) periodsToDelete.push(periodName);
        });
      } else if (isExam && targetPeriods.length === 1 && targetPeriods[0] !== period) {
        periodsToDelete.push(period);
      }
      for (const periodName of periodsToDelete) {
        await env.DB.prepare(
          'DELETE FROM blocus_slots WHERE blocus_id = ? AND day = ? AND period = ? AND username = ?'
        ).bind(blocusId, day, periodName, user.username).run();
      }

      const { results: rowsAfterSave } = await env.DB.prepare(
        `SELECT period, course_id, section_id, is_exam, exam_note, exam_start_time, exam_end_time
         FROM blocus_slots
         WHERE blocus_id = ? AND day = ? AND username = ?`
      ).bind(blocusId, day, user.username).all();
      const slots = {
        morning: { period: 'morning', courseId: '', sectionId: '', isExam: 0, examNote: '', examStartTime: '', examEndTime: '' },
        afternoon: { period: 'afternoon', courseId: '', sectionId: '', isExam: 0, examNote: '', examStartTime: '', examEndTime: '' }
      };
      rowsAfterSave.forEach(row => {
        if (!slots[row.period]) return;
        slots[row.period] = {
          period: row.period,
          courseId: row.course_id || '',
          sectionId: row.section_id || '',
          isExam: Number(row.is_exam) === 1 ? 1 : 0,
          examNote: row.exam_note || '',
          examStartTime: row.exam_start_time || '',
          examEndTime: row.exam_end_time || ''
        };
      });

      return new Response(JSON.stringify({ day, slots, appliedPeriods: targetPeriods }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/api/blocus/course/create' && method === 'POST') {
      const fd = await req.formData();
      const blocusId = (fd.get('blocusId') || '').toString();
      const name = (fd.get('name') || '').toString().trim();
      if (!blocusId || !name) return new Response('Course name is required.', { status: 400 });

      const blocus = await env.DB.prepare(
        'SELECT id FROM blocus_boards WHERE id = ? AND username = ?'
      ).bind(blocusId, user.username).first();
      if (!blocus) return new Response('Calendar not found.', { status: 404 });

      let sectionNames;
      try {
        sectionNames = normalizeBlocusSectionNames(JSON.parse((fd.get('sections') || '[]').toString()));
      } catch {
        return new Response('Invalid sections payload.', { status: 400 });
      }

      const maxPosRow = await env.DB.prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM blocus_courses WHERE blocus_id = ? AND username = ?'
      ).bind(blocusId, user.username).first();
      const position = Number(maxPosRow?.max_pos ?? -1) + 1;
      const fallbackColor = BLOCUS_PASTELS[position % BLOCUS_PASTELS.length];
      const color = normalizeHexColor((fd.get('color') || '').toString(), fallbackColor);
      const now = Date.now();
      const courseId = crypto.randomUUID();

      await env.DB.prepare(
        'INSERT INTO blocus_courses (id, blocus_id, username, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(courseId, blocusId, user.username, name, color, position, now).run();
      await syncBlocusCourseSections(env.DB, blocusId, courseId, user.username, sectionNames);

      return new Response(JSON.stringify({ id: courseId }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/api/blocus/course/update' && method === 'POST') {
      const fd = await req.formData();
      const blocusId = (fd.get('blocusId') || '').toString();
      const courseId = (fd.get('courseId') || '').toString();
      const name = (fd.get('name') || '').toString().trim();
      if (!blocusId || !courseId || !name) return new Response('Invalid course payload.', { status: 400 });

      const course = await env.DB.prepare(
        'SELECT id, color FROM blocus_courses WHERE id = ? AND blocus_id = ? AND username = ?'
      ).bind(courseId, blocusId, user.username).first();
      if (!course) return new Response('Course not found.', { status: 404 });

      let sectionNames;
      try {
        sectionNames = normalizeBlocusSectionNames(JSON.parse((fd.get('sections') || '[]').toString()));
      } catch {
        return new Response('Invalid sections payload.', { status: 400 });
      }

      const color = normalizeHexColor((fd.get('color') || '').toString(), normalizeHexColor(course.color, '#B8B5FF'));
      await env.DB.prepare(
        'UPDATE blocus_courses SET name = ?, color = ? WHERE id = ? AND blocus_id = ? AND username = ?'
      ).bind(name, color, courseId, blocusId, user.username).run();
      await syncBlocusCourseSections(env.DB, blocusId, courseId, user.username, sectionNames);

      return new Response('OK');
    }

    if (path === '/api/blocus/course/delete' && method === 'POST') {
      const fd = await req.formData();
      const blocusId = (fd.get('blocusId') || '').toString();
      const courseId = (fd.get('courseId') || '').toString();
      if (!blocusId || !courseId) return new Response('Invalid course payload.', { status: 400 });

      await env.DB.prepare(
        'DELETE FROM blocus_courses WHERE id = ? AND blocus_id = ? AND username = ?'
      ).bind(courseId, blocusId, user.username).run();

      return new Response('OK');
    }

    // API: LIST
    if (path === '/api/list/create' && method === 'POST') {
      const fd = await req.formData();
      const { results: lists } = await env.DB.prepare('SELECT * FROM lists WHERE board_id = ? ORDER BY position ASC').bind(fd.get('boardId')).all();
      const pos = lists.length > 0 ? Math.max(...lists.map(l => l.position)) + 1 : 0;
      await env.DB.prepare('INSERT INTO lists (id, board_id, username, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), fd.get('boardId'), user.username, fd.get('name'), pos, fd.get('color') || '#bb86fc', Date.now()).run();
      return new Response('OK');
    }

    if (path === '/api/list/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM lists WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/list/rename' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('UPDATE lists SET name = ? WHERE id = ? AND username = ?').bind(fd.get('name'), fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/list/reorder' && method === 'POST') {
      const fd = await req.formData();
      const lid = fd.get('listId'), npos = parseInt(fd.get('newPosition'));
      const list = await env.DB.prepare('SELECT * FROM lists WHERE id = ?').bind(lid).first();
      await env.DB.prepare('UPDATE lists SET position = position - 1 WHERE board_id = ? AND position > ?').bind(list.board_id, list.position).run();
      await env.DB.prepare('UPDATE lists SET position = position + 1 WHERE board_id = ? AND position >= ?').bind(list.board_id, npos).run();
      await env.DB.prepare('UPDATE lists SET position = ? WHERE id = ?').bind(npos, lid).run();
      return new Response('OK');
    }

    // API: CARD
    if (path === '/api/card/create' && method === 'POST') {
      const fd = await req.formData();
      const lid = fd.get('listId');
      const { results: cards } = await env.DB.prepare('SELECT * FROM cards WHERE list_id = ? ORDER BY position ASC').bind(lid).all();
      const pos = cards.length > 0 ? Math.max(...cards.map(c => c.position)) + 1 : 0;
      const list = await env.DB.prepare('SELECT board_id FROM lists WHERE id = ?').bind(lid).first();
      await env.DB.prepare('INSERT INTO cards (id, list_id, board_id, username, title, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), lid, list.board_id, user.username, fd.get('title'), '', pos, Date.now()).run();
      return new Response('OK');
    }

    if (path === '/api/card/update' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('UPDATE cards SET title = ?, description = ? WHERE id = ? AND username = ?').bind(fd.get('title'), fd.get('description'), fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/card/delete' && method === 'POST') {
      const fd = await req.formData();
      await env.DB.prepare('DELETE FROM cards WHERE id = ? AND username = ?').bind(fd.get('id'), user.username).run();
      return new Response('OK');
    }

    if (path === '/api/card/move' && method === 'POST') {
      const fd = await req.formData();
      const cid = fd.get('cardId'), nlid = fd.get('newListId'), npos = parseInt(fd.get('newPosition'));
      const card = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(cid).first();
      await env.DB.prepare('UPDATE cards SET position = position - 1 WHERE list_id = ? AND position > ?').bind(card.list_id, card.position).run();
      await env.DB.prepare('UPDATE cards SET position = position + 1 WHERE list_id = ? AND position >= ?').bind(nlid, npos).run();
      await env.DB.prepare('UPDATE cards SET list_id = ?, position = ? WHERE id = ?').bind(nlid, npos, cid).run();
      return new Response('OK');
    }

    if (path === '/api/password' && method === 'POST') {
      const fd = await req.formData();
      await env.AUTH_DB.prepare('UPDATE users SET password = ? WHERE username = ?').bind(await hash(fd.get('p')), user.username).run();
      return new Response('OK');
    }

    // PAGES
    const basePath = url.pathname.startsWith('/todo') ? '/todo' : '';
    if (path === '/settings') return new Response(renderSettings(user, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    if (path.startsWith('/board/')) {
      const bid = path.split('/board/')[1];
      const board = await env.DB.prepare('SELECT * FROM boards WHERE id = ? AND username = ?').bind(bid, user.username).first();
      if (!board) return new Response('404', { status: 404 });
      const { results: lists } = await env.DB.prepare('SELECT * FROM lists WHERE board_id = ? ORDER BY position ASC').bind(bid).all();
      const { results: cards } = await env.DB.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY position ASC').bind(bid).all();
      return new Response(renderBoard(user, board, lists, cards, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path.startsWith('/blocus/')) {
      const blocusId = path.split('/blocus/')[1];
      const blocus = await env.DB.prepare('SELECT * FROM blocus_boards WHERE id = ? AND username = ?').bind(blocusId, user.username).first();
      if (!blocus) return new Response('404', { status: 404 });
      const { results: courses } = await env.DB.prepare(
        'SELECT * FROM blocus_courses WHERE blocus_id = ? ORDER BY position ASC'
      ).bind(blocusId).all();
      const { results: sections } = await env.DB.prepare(
        'SELECT * FROM blocus_course_sections WHERE blocus_id = ? ORDER BY position ASC'
      ).bind(blocusId).all();
      const { results: slots } = await env.DB.prepare(
        'SELECT * FROM blocus_slots WHERE blocus_id = ? ORDER BY day ASC'
      ).bind(blocusId).all();
      return new Response(renderBlocus(user, blocus, courses, sections, slots, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path === '/' || url.pathname === '') {
      const { results: boards } = await env.DB.prepare('SELECT * FROM boards WHERE username = ? ORDER BY created_at DESC').bind(user.username).all();
      const { results: blocusBoards } = await env.DB.prepare('SELECT * FROM blocus_boards WHERE username = ? ORDER BY created_at DESC').bind(user.username).all();
      return new Response(renderDash(user, boards, blocusBoards, basePath), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response('404', { status: 404 });
  }
};

async function hash(str) {
  const buf = new TextEncoder().encode(str);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeRole(r) {
  if (r === 'admin') return 'owner';
  if (r === 'guest+') return 'member';
  if (r === 'guest') return 'viewer';
  return r || 'viewer';
}
function isOwner(u) { return normalizeRole(u?.role) === 'owner'; }
const ROLE_META = {
  owner: { label: 'Owner', color: '#2576eb', bg: 'rgba(37,118,235,0.10)', border: 'rgba(37,118,235,0.25)', icon: '🔑' },
  member: { label: 'Member', color: '#44474b', bg: '#f2f5f7', border: '#dfe3e8', icon: '📁' },
  viewer: { label: 'Viewer', color: '#838b96', bg: '#f2f5f7', border: '#dfe3e8', icon: '👁' }
};
const ROLE_PERMS = {
  owner: ['Upload any file type', 'Delete any file', 'Share files', 'Manage users & roles', 'Access admin panel'],
  member: ['Upload any file type', 'Delete own files', 'Share files'],
  viewer: ['Upload PDF files only', 'Delete own files']
};

// Helper: Get base path prefix
const BASE_PATH = (path) => path.startsWith('/todo') ? '/todo' : '';
const BLOCUS_PASTELS = ['#B86BFF', '#D86EFF', '#F86BC7', '#9A7CFF', '#7FA2FF', '#68D2FF', '#6CEFE5', '#C58FFF'];
const BLOCUS_EXAM_OUTLINE = '#dc2626';

// CSS - Simple Dark Theme (like Habit Tracker)
const CSS = `
:root{
  --bg:#ffffff;--surface:#f2f5f7;--surface-hover:#e8edf1;--surface-soft:#f7f9fb;
  --text:#303336;--text-secondary:#44474b;--text-muted:#838b96;--border:#dfe3e8;
  --accent:#2576eb;--accent-pink:#5c9cf5;
  --accent-soft:rgba(37,118,235,0.08);--accent-glow:rgba(37,118,235,0.18);
  --action:#4f91fb;
  --danger:#dc2626;--danger-soft:rgba(220,38,38,0.08);
  --good:#16a34a;--good-soft:rgba(22,163,74,0.10);
  --warn:#b45309;
  --radius-sm:3px;--radius:6px;--radius-md:6px;--radius-lg:18px;--radius-xl:18px;--radius-hero:12.8px;
  --transition:150ms ease-out;
  --shadow-sm:rgba(0,0,0,0.08) 0px 2px 8px 0px, rgba(0,0,0,0.06) 0px 0px 2px 0px;
  --shadow:rgba(0,0,0,0.08) 0px 2px 8px 0px, rgba(0,0,0,0.06) 0px 0px 2px 0px;
  --shadow-lg:rgba(0,0,0,0.10) 0px 8px 28px 0px, rgba(0,0,0,0.06) 0px 0px 2px 0px;
  --font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-mono:var(--font);
  --text-caption:13px;--text-body:16px;--text-subheading:18px;--text-heading:24px;--text-display:36px;
  --leading-caption:1.4;--leading-body:1.6;--leading-subheading:1.35;--leading-heading:1.25;--leading-display:1.2;
  --page-max:900px;--page-wide:1200px;--section-gap:48px;
  --card:var(--surface);--txt-main:var(--text);--txt-muted:var(--text-secondary);
  --p:var(--accent);--err:var(--danger);
}
*,*::before,*::after{box-sizing:border-box}
html,body{height:auto}
body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:var(--leading-body);font-size:var(--text-body);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body > :not(header):not(script):not(.modal){max-width:var(--page-max);margin-left:auto;margin-right:auto;padding-left:24px;padding-right:24px}
body.wide > :not(header):not(script):not(.modal){max-width:var(--page-wide)}
body.full > :not(header):not(script):not(.modal){max-width:none;padding-left:32px;padding-right:32px}
h1,h2,h3,h4{letter-spacing:-0.015em;font-weight:700;margin:0;color:var(--text)}
h1{font-size:var(--text-display);line-height:var(--leading-display);font-weight:800;letter-spacing:-0.02em}
h2{font-size:var(--text-heading);line-height:var(--leading-heading)}
h3{font-size:var(--text-subheading);line-height:var(--leading-subheading);font-weight:700}
h4{font-size:var(--text-body);line-height:var(--leading-body);font-weight:700}
p{margin:0;color:var(--text-secondary)}
::selection{background:var(--accent-glow)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input,textarea,select,button{font:inherit;color:inherit}
input,textarea,select{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:var(--radius);margin:0;transition:border-color var(--transition);font-size:var(--text-body);line-height:1.4;width:100%}
input::placeholder,textarea::placeholder{color:var(--subtle-ash,var(--text-muted))}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);background:var(--bg);box-shadow:none}
button{cursor:pointer;background:var(--action);color:#fff;font-weight:600;border:1px solid transparent;padding:7px 17px;border-radius:var(--radius);transition:background var(--transition),color var(--transition),border-color var(--transition);font-size:var(--text-body);line-height:1.3;box-shadow:none}
button:hover{background:var(--accent-pink)}
button:active{background:var(--accent)}
button.ghost,.btn-ghost{background:transparent;color:var(--accent);border:1px solid transparent;font-weight:600}
button.ghost:hover,.btn-ghost:hover{background:var(--surface);color:var(--accent)}
button.subtle{background:transparent;color:var(--text-secondary);border:1px solid var(--border)}
button.subtle:hover{background:var(--surface);color:var(--text);border-color:var(--border)}
button.danger,.btn-danger{background:transparent;color:var(--text-secondary);border:1px solid var(--border);font-weight:600}
button.danger:hover,.btn-danger:hover{background:transparent;color:var(--danger);border-color:var(--danger)}
.card{background:var(--surface);padding:18px;border-radius:var(--radius-lg);margin-bottom:24px;border:none;box-shadow:none}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
a{color:var(--accent);text-decoration:none;transition:color var(--transition)}
a:hover{color:var(--accent-pink)}
.page-hero{margin:48px 0 32px}
.page-hero h1{margin:0 0 8px}
.page-hero p{font-size:var(--text-subheading);line-height:var(--leading-subheading);color:var(--text-secondary)}
.page-section{margin-top:var(--section-gap)}
.page-section-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:16px}
.page-section-head h2{margin:0}
.page-section-head .helper{color:var(--text-muted);font-size:var(--text-caption);line-height:var(--leading-caption);font-weight:500}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:24px}
header{display:flex;justify-content:space-between;align-items:center;height:60px;padding:0 24px;background:var(--bg);border-bottom:1px solid var(--border);box-shadow:none;position:sticky;top:0;z-index:50;flex-wrap:nowrap;gap:12px;margin:0 0 0}
header strong{font-size:var(--text-body);letter-spacing:-0.02em;color:var(--text);font-weight:700}
.user-wrap{position:relative}
.user-btn{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:var(--text-caption);font-weight:600;padding:6px 10px;border-radius:var(--radius);background:transparent;border:1px solid transparent;cursor:pointer;transition:background var(--transition),color var(--transition);white-space:nowrap;box-shadow:none}
.user-btn:hover{background:var(--surface);color:var(--text)}
.user-btn .caret{transition:transform var(--transition);margin-left:2px;color:var(--text-muted)}
.user-wrap.open .user-btn .caret{transform:rotate(180deg)}
.dd{display:none;position:absolute;right:0;top:calc(100% + 8px);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);min-width:260px;box-shadow:var(--shadow-lg);z-index:999;overflow:hidden}
.user-wrap.open .dd{display:block;animation:dd 150ms ease-out}
@keyframes dd{from{opacity:0;transform:translateY(-4px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}
.dd-hdr{padding:16px 18px 14px;border-bottom:1px solid var(--border)}
.dd-name{font-weight:700;font-size:var(--text-body);margin-bottom:8px;color:var(--text);letter-spacing:-0.01em}
.role-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:0.04em;margin-bottom:10px;text-transform:uppercase;background:var(--accent-soft);color:var(--accent)}
.perm-list{list-style:none;padding:0;margin:0}
.perm-list li{font-size:var(--text-caption);color:var(--text-secondary);padding:3px 0;display:flex;align-items:center;gap:8px}
.perm-list li.ok{color:var(--text)}
.pcheck{width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:9px;font-weight:700}
.pcheck.y{background:var(--good-soft);color:var(--good)}
.pcheck.n{background:var(--surface);color:var(--text-muted)}
.ddl{display:flex;align-items:center;gap:10px;padding:10px 18px;color:var(--text);text-decoration:none;font-size:var(--text-body);font-weight:500;transition:background var(--transition),color var(--transition)}
.ddl:hover{background:var(--surface);color:var(--accent)}
.dd-sep{height:1px;background:var(--border);margin:4px 0}
.ddl.out{color:var(--danger)!important}
.ddl.out:hover{background:var(--danger-soft)!important;color:var(--danger)}
.nav-link{padding:6px 0;margin:0 6px;border-radius:0;background:transparent;border:none;color:var(--text-muted);font-weight:600;font-size:15px;line-height:1.3;transition:color var(--transition);display:inline-flex;align-items:center;gap:6px}
.nav-link:hover{color:var(--accent)}
.nav-link.active{color:var(--accent);background:transparent;border-color:transparent;box-shadow:none}
.board-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin:0}
.board-item{background:var(--surface);padding:20px 22px;border-radius:var(--radius-lg);border:none;cursor:pointer;transition:background var(--transition);box-shadow:none;position:relative;overflow:hidden;display:flex;flex-direction:column;gap:10px;min-height:120px}
.board-item::before{content:none}
.board-item:hover{background:var(--surface-hover);transform:none;box-shadow:none}
.board-item h3{margin:0;font-size:var(--text-subheading);font-weight:700;letter-spacing:-0.01em;line-height:1.3}
.board-item .meta{color:var(--text-muted);font-size:var(--text-caption);line-height:var(--leading-caption);margin:0;font-weight:500}
.board-item .actions{margin-top:auto;display:flex;justify-content:flex-end;opacity:0;transition:opacity var(--transition)}
.board-item:hover .actions{opacity:1}
.board-item button{background:transparent;border:1px solid transparent;color:var(--text-muted);box-shadow:none;padding:4px 10px;font-size:var(--text-caption);font-weight:600;border-radius:var(--radius)}
.board-item button:hover{background:transparent;color:var(--danger);border-color:var(--danger)}
.empty-state{padding:48px 24px;text-align:center;color:var(--text-muted);background:var(--surface);border-radius:var(--radius-lg);font-size:var(--text-body)}
.kanban{display:flex;gap:20px;overflow-x:auto;padding:8px 4px 24px;min-height:70vh}
.kanban::-webkit-scrollbar{height:8px}
.kanban::-webkit-scrollbar-thumb{background:var(--border);border-radius:999px}
.list{min-width:300px;max-width:300px;background:var(--surface);border:none;border-radius:var(--radius-lg);display:flex;flex-direction:column;max-height:calc(100vh - 180px);transition:transform var(--transition),opacity var(--transition);box-shadow:none}
.list.dragging{opacity:0.4;transform:scale(0.97)}
.list.placeholder{background:var(--accent-soft);border:2px dashed var(--accent);opacity:0.7;min-height:200px;border-radius:var(--radius-lg)}
.list-header{background:transparent;padding:16px 18px 12px;border-radius:var(--radius-lg) var(--radius-lg) 0 0;display:flex;justify-content:space-between;align-items:center;border-bottom:none;user-select:none;gap:8px}
.list-header input{background:transparent;border:1px solid transparent;color:var(--text);font-weight:700;font-size:var(--text-subheading);padding:2px 4px;margin:0;flex:1;box-shadow:none;letter-spacing:-0.01em;line-height:1.3;width:auto}
.list-header input:focus{background:var(--bg);border-color:var(--accent);border-radius:var(--radius-sm);box-shadow:none}
.list-header .count{background:transparent;color:var(--text-muted);padding:0 4px;border-radius:999px;font-size:var(--text-caption);font-weight:600;font-family:var(--font);min-width:20px;text-align:right}
.list-header button{background:transparent;color:var(--text-muted);border:1px solid transparent;padding:4px 8px;font-size:var(--text-caption);cursor:pointer;border-radius:var(--radius-sm);box-shadow:none}
.list-header button:hover{color:var(--danger);background:transparent;border-color:transparent;transform:none;box-shadow:none}
.cards{flex:1;overflow-y:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:8px}
.cards::-webkit-scrollbar{width:4px}
.cards::-webkit-scrollbar-thumb{background:var(--border);border-radius:999px}
.task-card{background:var(--bg);border:1px solid transparent;border-radius:var(--radius);padding:12px 14px;cursor:grab;position:relative;transition:box-shadow var(--transition),border-color var(--transition);box-shadow:var(--shadow-sm)}
.task-card:hover{border-color:transparent;box-shadow:var(--shadow);transform:none}
.task-card:hover .card-actions{opacity:1}
.task-card:active{cursor:grabbing;transform:scale(0.99)}
.task-card.dragging{opacity:0.4;transform:scale(0.97);box-shadow:none}
.card-title{font-weight:600;margin-bottom:2px;line-height:1.4;color:var(--text);font-size:var(--text-body)}
.card-desc{color:var(--text-secondary);font-size:var(--text-caption);margin-top:6px;line-height:var(--leading-caption)}
.card-actions{opacity:0;display:flex;gap:6px;margin-top:10px;transition:opacity var(--transition);pointer-events:auto;border-top:1px solid var(--border);padding-top:10px}
.task-card:hover .card-actions,.card-actions:hover,.card-actions:focus-within{opacity:1!important}
.card-actions button{background:transparent;color:var(--text-muted);border:1px solid transparent;padding:4px 10px;border-radius:var(--radius-sm);font-size:var(--text-caption);cursor:pointer;pointer-events:all;box-shadow:none;font-weight:600;flex:1}
.card-actions button:hover{background:var(--surface);color:var(--text);transform:none;box-shadow:none}
.card-actions button.del:hover{color:var(--danger);background:transparent;border-color:transparent}
.add-card{padding:10px 14px;margin:0 12px 12px;background:transparent;border:none;border-radius:var(--radius);color:var(--text-muted);text-align:left;cursor:pointer;font-size:var(--text-caption);font-weight:600;transition:color var(--transition),background var(--transition);width:auto}
.add-card:hover{color:var(--accent);background:transparent}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(48,51,54,0.32);backdrop-filter:blur(8px);z-index:1000;align-items:center;justify-content:center;padding:20px}
.modal.active{display:flex;animation:fadeIn 0.2s ease-out}
@keyframes fadeIn{from{opacity:0;transform:scale(0.98)}to{opacity:1;transform:scale(1)}}
.modal-content{background:var(--bg);padding:32px;border-radius:var(--radius-xl);border:none;max-width:480px;width:100%;box-shadow:var(--shadow-lg)}
.modal-content h3{margin:0 0 20px;font-size:var(--text-heading);line-height:var(--leading-heading);font-weight:700;letter-spacing:-0.015em}
.form-group{margin-bottom:18px}
.form-group label{display:block;margin-bottom:6px;color:var(--text-secondary);font-size:var(--text-caption);line-height:var(--leading-caption);font-weight:600;letter-spacing:0}
.form-group input,.form-group textarea,.form-group select{width:100%}
.btn-group{display:flex;gap:10px;margin-top:24px}
.btn-group button{flex:1}
.section-title{font-size:var(--text-heading);line-height:var(--leading-heading);font-weight:700;margin:0 0 16px;color:var(--text);letter-spacing:-0.015em}
.input-row{display:flex;gap:10px;align-items:flex-end}
.input-row>*{flex:1}
.small-btn{padding:8px 14px;white-space:nowrap}
.course-builder-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.course-builder-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:none;border-radius:var(--radius);background:var(--surface)}
.course-color-dot{width:10px;height:10px;border-radius:999px;display:inline-block;flex-shrink:0}
.chip-list{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:var(--text-caption);font-weight:600;border:none;background:var(--surface);color:var(--text-secondary)}
.hidden{display:none!important}
.mode-toggle{display:inline-flex;gap:0;margin-bottom:18px;padding:3px;background:var(--surface);border-radius:var(--radius);align-items:center}
.mode-btn{background:transparent;border:none;color:var(--text-secondary);box-shadow:none;padding:6px 14px;font-size:var(--text-caption);font-weight:600;border-radius:calc(var(--radius) - 2px)}
.mode-btn:hover{transform:none;background:transparent;color:var(--text)}
.mode-btn.active{background:var(--bg);color:var(--text);border-color:transparent;box-shadow:var(--shadow-sm)}
.calendar-meta{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px;color:var(--text-secondary);font-size:var(--text-caption)}
.calendar-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.calendar-legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.calendar-legend-item{display:flex;gap:8px;align-items:center;padding:5px 12px;border:none;border-radius:999px;background:var(--surface)}
.calendar-legend-item .name{font-size:var(--text-caption);font-weight:600;color:var(--text)}
.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:10px}
.calendar-empty{border:none;min-height:210px}
.calendar-day{min-height:210px;background:var(--surface);border:none;border-radius:var(--radius-lg);display:flex;flex-direction:column;overflow:hidden}
.calendar-day-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--border);background:transparent;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:700}
.calendar-day-head .day-num{font-size:var(--text-body);font-weight:700;color:var(--text);letter-spacing:-0.01em}
.calendar-slot{flex:1;display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-top:1px solid var(--border);background:transparent;transition:background var(--transition),border-color var(--transition);--slot-label-color:var(--text-muted);--slot-main-color:var(--text);--slot-empty-color:var(--text-muted);--slot-badge-bg:var(--accent-soft);--slot-badge-border:transparent;--slot-badge-color:var(--accent);--slot-note-color:var(--text-secondary);--slot-countdown-color:var(--text);--slot-divider-color:var(--border)}
.calendar-slot:first-of-type{border-top:none}
.calendar-slot.selectable{cursor:pointer}
.calendar-slot.selected{box-shadow:inset 0 0 0 2px var(--accent);border-color:var(--accent)!important}
.calendar-slot-label-row{display:flex;justify-content:space-between;align-items:center;gap:6px}
.calendar-slot-label-main{display:flex;align-items:center;gap:8px;min-width:0}
.calendar-slot-label{font-size:0.7rem;color:var(--slot-label-color);font-weight:700;text-transform:uppercase;letter-spacing:0.05em}
.calendar-slot-label-time{font-size:0.7rem;font-weight:700;line-height:1.2;color:var(--slot-note-color);white-space:nowrap}
.calendar-slot select,.calendar-slot input{margin:0;padding:6px 8px;font-size:0.8rem}
.calendar-slot input{min-width:0}
.slot-selector{display:none;background:transparent;border:1px solid var(--border);color:var(--text-secondary);padding:2px 8px;font-size:0.7rem;line-height:1.2;border-radius:999px;box-shadow:none}
.slot-selector:hover{transform:none;box-shadow:none;background:var(--surface);color:var(--text)}
.calendar-slot.selected .slot-selector{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.slot-view,.slot-edit{display:flex;flex-direction:column;gap:6px;flex:1}
.slot-view{justify-content:flex-start}
.slot-view-main{font-size:0.88rem;font-weight:700;line-height:1.35;color:var(--slot-main-color)}
.slot-view-empty{color:var(--slot-empty-color);font-weight:500}
.slot-view-badge{display:inline-flex;align-items:center;width:fit-content;font-size:0.74rem;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--slot-badge-bg);border:1px solid var(--slot-badge-border);color:var(--slot-badge-color)}
.slot-view-note{font-size:0.78rem;line-height:1.4;color:var(--slot-note-color)}
.slot-countdown{margin-top:auto;padding-top:6px;border-top:1px solid var(--slot-divider-color);font-size:0.74rem;font-weight:700;color:var(--slot-countdown-color)}
.exam-time-row{display:flex;flex-direction:column;gap:6px}
.time-select-wrap{display:flex;flex-direction:column;gap:4px}
.time-select-label{font-size:0.66rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--slot-label-color)}
.time-select{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:4px;align-items:center}
.time-select select{margin:0;padding:6px 8px;letter-spacing:0.02em;min-width:0;width:100%}
.time-colon{font-weight:700;color:var(--slot-note-color);font-size:0.95rem}
.course-editor{margin-bottom:18px}
.course-editor-toggle{width:100%;display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:0;border:none;background:transparent;color:var(--text);box-shadow:none}
.course-editor-toggle:hover{transform:none;box-shadow:none;background:transparent;color:var(--accent)}
.course-editor-chevron{display:inline-flex;align-items:center;justify-content:center;width:16px;line-height:1;transition:transform var(--transition)}
.course-editor-toggle[aria-expanded="true"] .course-editor-chevron{transform:rotate(90deg)}
.course-editor-toggle .helper{color:var(--text-muted);font-size:0.82rem;font-weight:500}
.course-editor-body{margin-top:12px}
.course-edit-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.course-edit-row{display:grid;grid-template-columns:minmax(160px,1.2fr) minmax(190px,1.3fr) minmax(220px,1.8fr) auto auto;gap:8px;align-items:center;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.course-color-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.preset-colors{display:flex;flex-wrap:wrap;gap:6px}
.preset-color-btn{width:20px;height:20px;min-width:20px;padding:0;border-radius:999px;border:1px solid var(--border);box-shadow:none;transform:none}
.preset-color-btn:hover{transform:none;box-shadow:none}
.preset-color-btn.active{outline:2px solid var(--accent);outline-offset:1px}
.course-edit-row .course-edit-color{padding:3px;height:32px;min-width:0}
.course-edit-row.new-course{border-style:dashed}
.past-days{margin-top:24px}
.past-days h3{margin:0}
.empty-calendar{padding:18px;text-align:center;color:var(--text-muted)}
.batch-panel{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.batch-panel .batch-count{font-size:0.8rem;color:var(--text-secondary);padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--bg)}
.batch-panel select{max-width:290px;min-width:220px}
body[data-blocus-mode="view"] .slot-edit{display:none}
body[data-blocus-mode="edit"] .slot-view{display:none}
body[data-blocus-mode="view"] .course-editor{display:none}
body[data-blocus-mode="view"] .batch-panel{display:none}
body[data-blocus-mode="edit"] .calendar-slot.selectable .slot-selector{display:inline-flex}
@media (max-width:1200px){.calendar-grid{grid-template-columns:repeat(4,minmax(150px,1fr))}}
@media (max-width:1100px){.course-edit-row{grid-template-columns:1fr 1fr 1fr auto auto}}
@media (max-width:900px){.calendar-grid{grid-template-columns:repeat(2,minmax(140px,1fr))}.input-row{flex-direction:column;align-items:stretch}.course-edit-row{grid-template-columns:1fr}.course-edit-row>button{width:100%}.batch-panel{align-items:stretch}.batch-panel select{max-width:none;min-width:0;flex:1 1 100%}}
@media (max-width:560px){.calendar-grid{grid-template-columns:1fr}}
`;

const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%234f91fb'/%3E%3Ctext x='16' y='21' font-family='Arial,sans-serif' font-weight='900' font-size='12' fill='white' text-anchor='middle'%3E111%3C/text%3E%3C/svg%3E`;

function renderBrand(appName = 'Todo List') {
  return `<a href="/" style="text-decoration:none;display:flex;align-items:center;gap:10px;flex-shrink:0">
    <span style="width:36px;height:36px;background:#4f91fb;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.05em;color:#fff;flex-shrink:0">111</span>
    <div style="display:flex;flex-direction:column;line-height:1.25">
      <span style="font-weight:700;font-size:1.1em;color:#303336;letter-spacing:-0.02em">111<span style="color:#2576eb">iridescence</span></span>
      <span style="font-size:0.72em;color:#838b96;font-weight:500;letter-spacing:0.03em">Hub</span>
    </div>
  </a>`;
}

function renderUserDropdown(user) {
  const id = 'uw' + Math.random().toString(36).slice(2, 6);
  const role = normalizeRole(user.role), rm = ROLE_META[role] || ROLE_META.viewer, perms = ROLE_PERMS[role] || [];
  const all = ['Upload any file type', 'Delete any file', 'Share files', 'Manage users & roles', 'Access admin panel'];
  return `<div class="user-wrap" id="${id}">
    <button class="user-btn" onclick="document.getElementById('${id}').classList.toggle('open')">
      ${user.username}
      <svg class="caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="dd">
      <div class="dd-hdr">
        <div class="dd-name">${user.username}</div>
        <span class="role-badge" style="background:${rm.bg};color:${rm.color};border:1px solid ${rm.border}">${rm.icon} ${rm.label}</span>
        <ul class="perm-list">${all.map(p => { const h = perms.includes(p); return `<li class="${h ? 'ok' : ''}"><span class="pcheck ${h ? 'y' : 'n'}">${h ? '✓' : '✕'}</span>${p}</li>`; }).join('')}</ul>
      </div>
      <a href="/auth/account" class="ddl">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>
        Account Preferences
      </a>
      ${isOwner(user) ? `<a href="/auth/admin" class="ddl">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        Admin Panel
      </a>` : ''}
      <div class="dd-sep"></div>
      <a href="/auth/logout" class="ddl out">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </a>
    </div>
  </div>
  <script>document.addEventListener('click',e=>{const w=document.getElementById('${id}');if(w&&!w.contains(e.target))w.classList.remove('open')});</script>`;
}

function renderAppSwitcher(basePath = '') {
  const id = 'uapps' + Math.random().toString(36).slice(2, 6);
  const todoHref = basePath || '/todo';
  return `<div class="user-wrap" id="${id}">
    <button class="user-btn" onclick="document.getElementById('${id}').classList.toggle('open')">
      Apps
      <svg class="caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="dd">
      <a href="/" class="ddl">🏠 Hub</a>
      <a href="/vault" class="ddl">🔒 Vault</a>
      <a href="/habits" class="ddl">📈 Habits</a>
      <a href="${todoHref}" class="ddl">✅ Todo</a>
      <a href="/courses" class="ddl">🎓 Courses</a>
      <a href="/editor" class="ddl">📝 Editor</a>
      <a href="/dashboard" class="ddl">📊 Dashboard</a>
      <a href="/feed" class="ddl">📰 Feed</a>
    </div>
  </div>
  <script>document.addEventListener('click',e=>{const w=document.getElementById('${id}');if(w&&!w.contains(e.target))w.classList.remove('open')});</script>`;
}

function renderNav(active, user, basePath = '') {
  return `<div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
    <a href="${basePath}/" class="nav-link ${active === 'boards' ? 'active' : ''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
      Boards</a>
    ${renderAppSwitcher(basePath)}
    ${renderUserDropdown(user)}
  </div>`;
}


function renderSettings(user, basePath = '') {
  return `<!DOCTYPE html><html lang="en"><head><title>111 Todo List</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="${FAVICON}"><style>${CSS}</style></head><body>
    <header>
      ${renderBrand('Todo List')}
      ${renderNav('settings', user, basePath)}
    </header>
    <div class="page-hero">
      <h1>Settings</h1>
      <p>Manage your account.</p>
    </div>
    <section class="page-section">
      <div class="page-section-head"><h2>Change password</h2></div>
      <div class="card">
        <form onsubmit="event.preventDefault();changePw(this)">
          <div class="form-group">
            <label>New password</label>
            <input type="password" name="p" required>
          </div>
          <button>Update password</button>
        </form>
      </div>
    </section>
    <script>
      async function changePw(f){
        const r = await fetch(BASE + '/api/password',{method:'POST',body:new FormData(f)});
        if(r.ok) alert('Password updated!');
      }
    </script>
  </body></html>`;
}


function renderDash(user, boards, blocusBoards = [], basePath = '') {
  return `<!DOCTYPE html><html lang="en"><head><title>111 Todo List</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="${FAVICON}"><style>${CSS}</style></head><body>
  <header>
    ${renderBrand('Todo List')}
    ${renderNav('boards', user, basePath)}
  </header>

  <div class="page-hero">
    <h1>Your boards</h1>
    <p>Plan tasks on kanban boards or schedule revision time on a blocus calendar.</p>
    <div class="toolbar">
      <button onclick="showModal()">New board</button>
      <button class="ghost" onclick="showBlocusModal()">New blocus calendar</button>
    </div>
  </div>

  <section class="page-section">
    <div class="page-section-head"><h2>Kanban boards</h2><span class="helper">${boards.length} ${boards.length === 1 ? 'board' : 'boards'}</span></div>
    ${boards.length === 0 ? '<div class="empty-state">No boards yet. Create your first board to get started.</div>' : `<div class="board-grid">
    ${boards.map(b => `
        <div class="board-item" onclick="location.href='${basePath}/board/${b.id}'">
          <h3>${escapeHtml(b.name)}</h3>
          <div class="meta">Created ${new Date(b.created_at).toLocaleDateString()}</div>
          <div class="actions"><button class="danger" onclick="event.stopPropagation();deleteBoard('${b.id}')">Delete</button></div>
        </div>
      `).join('')}
  </div>`}
  </section>

  <section class="page-section">
    <div class="page-section-head"><h2>Blocus calendars</h2><span class="helper">${blocusBoards.length} ${blocusBoards.length === 1 ? 'calendar' : 'calendars'}</span></div>
    ${blocusBoards.length === 0 ? '<div class="empty-state">No blocus calendar yet. Create one to plan your revision period.</div>' : `<div class="board-grid">
    ${blocusBoards.map(b => `
        <div class="board-item" onclick="location.href='${basePath}/blocus/${b.id}'">
          <h3>${escapeHtml(b.name)}</h3>
          <div class="meta">${escapeHtml(b.start_date)} → ${escapeHtml(b.end_date)}</div>
          <div class="actions"><button class="danger" onclick="event.stopPropagation();deleteBlocus('${b.id}')">Delete</button></div>
        </div>
      `).join('')}
  </div>`}
  </section>

  <!-- Board modal -->
  <div id="modal" class="modal">
    <div class="modal-content">
      <h3>Create Board</h3>
      <form onsubmit="event.preventDefault();createBoard(this)">
        <div class="form-group">
          <label>Board Name</label>
          <input type="text" name="name" required autofocus>
        </div>
        <div class="btn-group">
          <button>Create</button>
          <button type="button" class="btn-danger" onclick="hideModal()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Blocus modal -->
  <div id="blocusModal" class="modal">
    <div class="modal-content" style="max-width:760px">
      <h3>Create Blocus Calendar</h3>
      <form onsubmit="event.preventDefault();createBlocus(this)">
        <div class="form-group">
          <label>Calendar Name</label>
          <input type="text" name="name" required>
        </div>
        <div class="input-row">
          <div class="form-group">
            <label>Start date</label>
            <input type="date" name="startDate" required>
          </div>
          <div class="form-group">
            <label>End date</label>
            <input type="date" name="endDate" required>
          </div>
        </div>
        <div class="form-group">
          <label>Add your courses and optional exam subsections (comma separated)</label>
          <div class="input-row">
            <input id="courseNameInput" type="text" placeholder="Course name">
            <input id="courseSectionsInput" type="text" placeholder="Exam subsections (e.g. Midterm, Oral, Final)">
            <button type="button" class="small-btn" onclick="addCourse()">Add course</button>
          </div>
        </div>
        <div id="courseBuilderList" class="course-builder-list"></div>
        <div class="btn-group">
          <button>Create calendar</button>
          <button type="button" class="btn-danger" onclick="hideBlocusModal()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Confirmation Modal -->
  <div id="confirmModal" class="modal">
    <div class="modal-content" style="max-width:400px">
      <h3>⚠ Confirm Deletion</h3>
      <p id="confirmMessage" style="color:#44474b;margin:20px 0"></p>
      <div class="btn-group">
        <button id="confirmYes" class="btn-danger">Delete</button>
        <button id="confirmNo" onclick="hideConfirm()">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    const BASE = location.pathname.startsWith('/todo') ? '/todo' : '';
    const PASTEL_COLORS = ${JSON.stringify(BLOCUS_PASTELS)};
    let confirmCallback = null;
    let blocusCourses = [];

    function showConfirm(message, onConfirm) {
      confirmMessage.textContent = message;
      confirmCallback = onConfirm;
      confirmModal.classList.add('active');
    }

    function hideConfirm() {
      confirmModal.classList.remove('active');
      confirmCallback = null;
    }

    confirmYes.onclick = () => {
      if (confirmCallback) confirmCallback();
      hideConfirm();
    };

    function showModal(){ modal.classList.add('active'); }
    function hideModal(){ modal.classList.remove('active'); }
    function showBlocusModal(){ blocusModal.classList.add('active'); renderCourseBuilder(); }
    function hideBlocusModal(){ blocusModal.classList.remove('active'); }

    function escapeText(str){
      return (str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[c]));
    }

    function normalizeSectionNames(raw){
      return (raw || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .slice(0, 12);
    }

    function addCourse(){
      const name = (courseNameInput.value || '').trim();
      if (!name) {
        courseNameInput.focus();
        return;
      }
      const sections = normalizeSectionNames(courseSectionsInput.value);
      const color = PASTEL_COLORS[blocusCourses.length % PASTEL_COLORS.length];
      blocusCourses.push({ name, sections, color });
      courseNameInput.value = '';
      courseSectionsInput.value = '';
      renderCourseBuilder();
      courseNameInput.focus();
    }

    function removeCourse(index){
      blocusCourses.splice(index, 1);
      renderCourseBuilder();
    }

    function renderCourseBuilder(){
      if (blocusCourses.length === 0) {
        courseBuilderList.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem">No courses added yet.</span>';
        return;
      }

      courseBuilderList.innerHTML = blocusCourses.map((course, index) => {
        const sections = course.sections.length
          ? '<div class="chip-list">' + course.sections.map(s => '<span class="chip">' + escapeText(s) + '</span>').join('') + '</div>'
          : '<span style="font-size:0.75rem;color:var(--text-muted)">No subsections</span>';
        return \`<div class="course-builder-item">
            <div style="display:flex;align-items:flex-start;gap:8px;flex-direction:column">
              <div style="display:flex;align-items:center;gap:8px">
                <span class="course-color-dot" style="background:\${course.color}"></span>
                <strong style="font-size:0.86rem">\${escapeText(course.name)}</strong>
              </div>
              \${sections}
            </div>
            <button type="button" class="btn-danger small-btn" onclick="removeCourse(\${index})">Remove</button>
          </div>\`;
      }).join('');
    }

    function isValidPeriod(startDate, endDate){
      if (!startDate || !endDate) return false;
      const start = new Date(startDate + 'T00:00:00Z');
      const end = new Date(endDate + 'T00:00:00Z');
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
      if (end < start) return false;
      const maxEnd = new Date(start.getTime());
      maxEnd.setUTCMonth(maxEnd.getUTCMonth() + 4);
      maxEnd.setUTCDate(maxEnd.getUTCDate() - 1);
      return end <= maxEnd;
    }

    async function createBoard(f){
      const r = await fetch(BASE + '/api/board/create', { method:'POST', body:new FormData(f) });
      if (r.ok) {
        const d = await r.json();
        location.href = BASE + '/board/' + d.id;
      }
    }

    async function createBlocus(f){
      if (blocusCourses.length === 0) {
        alert('Add at least one course.');
        return;
      }

      const fd = new FormData(f);
      const startDate = (fd.get('startDate') || '').toString();
      const endDate = (fd.get('endDate') || '').toString();
      if (!isValidPeriod(startDate, endDate)) {
        alert('Pick a valid period between 1 day and 4 months.');
        return;
      }

      fd.set('courses', JSON.stringify(blocusCourses));
      const r = await fetch(BASE + '/api/blocus/create', { method:'POST', body:fd });
      if (!r.ok) {
        alert(await r.text() || 'Could not create calendar.');
        return;
      }
      const d = await r.json();
      location.href = BASE + '/blocus/' + d.id;
    }

    function deleteBoard(id){
      showConfirm('Delete this board? All lists and cards will be deleted.', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/board/delete', { method: 'POST', body: fd });
        location.reload();
      });
    }

    function deleteBlocus(id){
      showConfirm('Delete this blocus calendar? All courses and slots will be deleted.', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/blocus/delete', { method: 'POST', body: fd });
        location.reload();
      });
    }
  </script>
</body></html>`;
}

function renderBlocus(user, blocus, courses, sections, slots, basePath = '') {
  const coursesById = {};
  const sectionsByCourse = {};
  const sectionToCourse = {};
  const entryMeta = {};

  courses.forEach(course => {
    coursesById[course.id] = course;
    sectionsByCourse[course.id] = [];
    entryMeta[`course:${course.id}`] = {
      color: normalizeHexColor(course.color, '#B8B5FF'),
      label: course.name
    };
  });

  sections.forEach(section => {
    if (!sectionsByCourse[section.course_id]) sectionsByCourse[section.course_id] = [];
    sectionsByCourse[section.course_id].push(section);
    sectionToCourse[section.id] = section.course_id;
    const courseName = coursesById[section.course_id]?.name || 'Unknown course';
    const parentColor = normalizeHexColor(coursesById[section.course_id]?.color || '#B8B5FF', '#B8B5FF');
    entryMeta[`section:${section.id}`] = {
      color: parentColor,
      label: `${courseName} · ${section.name}`
    };
  });

  const slotByKey = {};
  slots.forEach(slot => {
    slotByKey[`${slot.day}|${slot.period}`] = slot;
  });

  const allDays = buildDateRange(blocus.start_date, blocus.end_date);
  const todayIso = toIsoDate(new Date());
  const upcomingDays = allDays.filter(day => day.iso >= todayIso);
  const pastDays = allDays.filter(day => day.iso < todayIso);

  const renderSelectOptions = (selectedValue, includeExamOption, placeholder) => {
    let html = '';
    if (includeExamOption) {
      html += `<option value="__exam__"${selectedValue === '__exam__' ? ' selected' : ''}>🏁 Exam day</option>`;
    }
    html += `<option value=""${!selectedValue ? ' selected' : ''}>${placeholder}</option>`;

    courses.forEach(course => {
      const courseValue = `course:${course.id}`;
      html += `<optgroup label="${escapeHtml(course.name)}">`;
      html += `<option value="${courseValue}"${selectedValue === courseValue ? ' selected' : ''}>${escapeHtml(course.name)} (general)</option>`;
      const subSections = sectionsByCourse[course.id] || [];
      subSections.forEach(section => {
        const sectionValue = `section:${section.id}`;
        html += `<option value="${sectionValue}"${selectedValue === sectionValue ? ' selected' : ''}>↳ ${escapeHtml(section.name)}</option>`;
      });
      html += `</optgroup>`;
    });
    return html;
  };

  const renderBatchOptions = () => {
    let html = '<option value="">— Choose assignment —</option><option value="__clear__">Clear slots</option>';
    courses.forEach(course => {
      html += `<optgroup label="${escapeHtml(course.name)}">`;
      html += `<option value="course:${course.id}">${escapeHtml(course.name)} (general)</option>`;
      (sectionsByCourse[course.id] || []).forEach(section => {
        html += `<option value="section:${section.id}">↳ ${escapeHtml(section.name)}</option>`;
      });
      html += '</optgroup>';
    });
    return html;
  };

  const renderColorPresetButtons = (selectedColor) => {
    const normalized = normalizeHexColor(selectedColor, BLOCUS_PASTELS[0]).toLowerCase();
    return BLOCUS_PASTELS.map(color => {
      const active = normalized === color.toLowerCase() ? ' active' : '';
      return `<button type="button" class="preset-color-btn${active}" data-color="${color}" style="background:${color}" title="${color}" onclick="applyPresetColor(this,event)"></button>`;
    }).join('');
  };

  const renderTimeOptions = (max, selectedValue, placeholder, includePlaceholder = true) => {
    let html = '';
    if (includePlaceholder) {
      html += `<option value=""${!selectedValue ? ' selected' : ''}>${placeholder}</option>`;
    }
    for (let i = 0; i <= max; i++) {
      const value = String(i).padStart(2, '0');
      html += `<option value="${value}"${selectedValue === value ? ' selected' : ''}>${value}</option>`;
    }
    return html;
  };

  const buildExamTimeLabel = (start, end) => {
    if (start && end) return `${start} → ${end}`;
    if (start) return `${start} →`;
    if (end) return `→ ${end}`;
    return '';
  };

  const parseTimeToMinutes = (time) => {
    if (!time) return null;
    const [hhRaw, mmRaw] = String(time).split(':');
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return (hh * 60) + mm;
  };

  const shouldMergeAllDaySlot = (dayIso) => {
    const morning = slotByKey[`${dayIso}|morning`];
    const afternoon = slotByKey[`${dayIso}|afternoon`];
    if (!morning || !afternoon) return false;
    if (Number(morning.is_exam) !== 1 || Number(afternoon.is_exam) !== 1) return false;
    if ((morning.course_id || '') !== (afternoon.course_id || '')) return false;
    if ((morning.section_id || '') !== (afternoon.section_id || '')) return false;
    if ((morning.exam_note || '') !== (afternoon.exam_note || '')) return false;
    const morningStart = normalizeExamTime(morning.exam_start_time || '') || '';
    const morningEnd = normalizeExamTime(morning.exam_end_time || '') || '';
    const afternoonStart = normalizeExamTime(afternoon.exam_start_time || '') || '';
    const afternoonEnd = normalizeExamTime(afternoon.exam_end_time || '') || '';
    if (!morningStart || !morningEnd || !afternoonStart || !afternoonEnd) return false;
    if (morningStart !== afternoonStart || morningEnd !== afternoonEnd) return false;
    const startMinutes = parseTimeToMinutes(morningStart);
    const endMinutes = parseTimeToMinutes(morningEnd);
    if (startMinutes === null || endMinutes === null) return false;
    const noon = 12 * 60;
    return startMinutes < noon && endMinutes > noon;
  };

  const renderSlot = (dayIso, period, label, { allDay = false } = {}) => {
    const slot = slotByKey[`${dayIso}|${period}`];
    const isExam = slot ? Number(slot.is_exam) === 1 : false;
    const targetValue = slot ? (slot.section_id ? `section:${slot.section_id}` : slot.course_id ? `course:${slot.course_id}` : '') : '';
    const mainValue = isExam ? '__exam__' : targetValue;
    const examForValue = isExam ? targetValue : '';
    const examNote = isExam ? (slot.exam_note || '') : '';
    const examStartTime = isExam ? (normalizeExamTime(slot.exam_start_time || '') || '') : '';
    const examEndTime = isExam ? (normalizeExamTime(slot.exam_end_time || '') || '') : '';
    const [examStartHour, examStartMinuteRaw] = examStartTime ? examStartTime.split(':') : ['', '00'];
    const [examEndHour, examEndMinuteRaw] = examEndTime ? examEndTime.split(':') : ['', '00'];
    const examStartMinute = examStartMinuteRaw || '00';
    const examEndMinute = examEndMinuteRaw || '00';
    const examTimeLabel = isExam ? buildExamTimeLabel(examStartTime, examEndTime) : '';
    const meta = entryMeta[targetValue];
    const style = getSlotStyle(meta?.color, isExam);
    const countdown = isExam ? formatDaysLeft(dayDiffBetweenIso(todayIso, dayIso)) : '';

    return `<div class="calendar-slot${allDay ? ' calendar-slot-all-day' : ''}" data-day="${dayIso}" data-period="${period}" data-all-day="${allDay ? '1' : '0'}" style="${style}">
      <div class="calendar-slot-label-row">
        <div class="calendar-slot-label-main">
          <div class="calendar-slot-label">${label}</div>
          <div class="calendar-slot-label-time ${isExam && examTimeLabel ? '' : 'hidden'}">${escapeHtml(examTimeLabel)}</div>
        </div>
        <button type="button" class="slot-selector" onclick="toggleSlotSelectionByButton(this,event)">Select</button>
      </div>
      <div class="slot-view">
        <div class="slot-view-main ${meta ? '' : 'slot-view-empty'}">${escapeHtml(meta?.label || 'No course selected')}</div>
        <div class="slot-view-note ${isExam && examNote ? '' : 'hidden'}">${escapeHtml(examNote)}</div>
        <div class="slot-countdown ${isExam ? '' : 'hidden'}" data-exam-date="${dayIso}">${escapeHtml(countdown)}</div>
      </div>
      <div class="slot-edit">
        <select class="slot-main" onchange="handleSlotChange(this)" oninput="handleSlotChange(this)">
          ${renderSelectOptions(mainValue, true, '— Select course —')}
        </select>
        <div class="exam-extra ${isExam ? '' : 'hidden'}">
          <select class="slot-exam-for" onchange="saveSlotFromInput(this)" oninput="saveSlotFromInput(this)">
            ${renderSelectOptions(examForValue, false, '— Exam for (course/subsection) —')}
          </select>
          <div class="exam-time-row">
            <div class="time-select-wrap">
              <div class="time-select-label">Start</div>
              <div class="time-select">
                <select class="slot-exam-start-hour" onchange="saveSlotFromInput(this)" oninput="saveSlotFromInput(this)">${renderTimeOptions(23, examStartHour, 'HH')}</select>
                <span class="time-colon">:</span>
                <select class="slot-exam-start-minute" onchange="saveSlotFromInput(this)" oninput="saveSlotFromInput(this)">${renderTimeOptions(59, examStartMinute, 'MM', false)}</select>
              </div>
            </div>
            <div class="time-select-wrap">
              <div class="time-select-label">End</div>
              <div class="time-select">
                <select class="slot-exam-end-hour" onchange="saveSlotFromInput(this)" oninput="saveSlotFromInput(this)">${renderTimeOptions(23, examEndHour, 'HH')}</select>
                <span class="time-colon">:</span>
                <select class="slot-exam-end-minute" onchange="saveSlotFromInput(this)" oninput="saveSlotFromInput(this)">${renderTimeOptions(59, examEndMinute, 'MM', false)}</select>
              </div>
            </div>
          </div>
          <input type="text" class="slot-exam-note" value="${escapeHtml(examNote)}" placeholder="Exam details" oninput="saveSlotFromInput(this,true)" onblur="saveSlotFromInput(this)">
        </div>
      </div>
    </div>`;
  };

  const renderDayCard = (day) => {
    const mergedAllDay = shouldMergeAllDaySlot(day.iso);
    const slotsHtml = mergedAllDay
      ? renderSlot(day.iso, 'afternoon', 'All day', { allDay: true })
      : `${renderSlot(day.iso, 'morning', 'Morning')}${renderSlot(day.iso, 'afternoon', 'Afternoon')}`;
    return `
    <div class="calendar-day">
      <div class="calendar-day-head">
        <span>${escapeHtml(day.weekday)}</span>
        <span class="day-num">${day.day}</span>
      </div>
      ${slotsHtml}
    </div>
  `;
  };

  const renderCalendarGrid = (days, withWeekOffset) => {
    if (days.length === 0) {
      return '<div class="card empty-calendar">No days in this section.</div>';
    }

    const leading = withWeekOffset
      ? (() => {
          const firstDate = parseIsoDate(days[0].iso);
          const offset = firstDate ? (firstDate.getUTCDay() + 6) % 7 : 0;
          return Array.from({ length: offset }).map(() => '<div class="calendar-empty"></div>').join('');
        })()
      : '';

    return `<div class="calendar-grid">${leading}${days.map(renderDayCard).join('')}</div>`;
  };

  return `<!DOCTYPE html><html lang="en"><head><title>${escapeHtml(blocus.name)} · Blocus</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="${FAVICON}"><style>${CSS}</style></head><body class="wide">
    <header>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        ${renderBrand('Todo List')}
        <span style="color:var(--border);font-size:1.2em">/</span>
        <a href="${basePath}/" style="color:var(--txt-muted);text-decoration:none;font-size:0.95em;transition:color 0.2s" onmouseover="this.style.color='var(--txt-main)'" onmouseout="this.style.color='var(--txt-muted)'">Boards</a>
        <span style="color:var(--border);font-size:1.2em">/</span>
        <strong style="color:var(--txt-main);font-size:0.95em">${escapeHtml(blocus.name)}</strong>
      </div>
      ${renderNav('', user, basePath)}
    </header>

    <div class="page-hero" style="margin:32px 0 24px">
      <h1 style="font-size:28px">${escapeHtml(blocus.name)}</h1>
      <p>${escapeHtml(blocus.start_date)} → ${escapeHtml(blocus.end_date)} · Morning + Afternoon slots · Pick a course/subsection or mark an exam day.</p>
    </div>

    <div class="calendar-toolbar">
      <div class="mode-toggle">
        <button id="modeViewBtn" type="button" class="mode-btn">Viewer mode</button>
        <button id="modeEditBtn" type="button" class="mode-btn">Edit mode</button>
      </div>
      <div class="batch-panel" id="batchPanel">
        <button id="multiSelectToggle" type="button" class="mode-btn">Enable multi-select</button>
        <span id="multiSelectCount" class="batch-count">0 selected</span>
        <select id="batchTargetSelect">
          ${renderBatchOptions()}
        </select>
        <button id="batchApplyBtn" type="button">Apply</button>
        <button id="batchClearSelectionBtn" type="button" class="btn-danger">Clear selection</button>
      </div>
      <div class="helper" style="color:var(--text-secondary);font-size:0.8rem">Viewer mode hides selectors and shows pure color blocks.</div>
    </div>

    <div class="calendar-legend">
      ${courses.map(course => `
        <div class="calendar-legend-item">
          <span class="course-color-dot" style="background:${escapeHtml(course.color)}"></span>
          <span class="name">${escapeHtml(course.name)}</span>
          ${(sectionsByCourse[course.id] || []).map(section => `<span class="chip">${escapeHtml(section.name)}</span>`).join('')}
        </div>
      `).join('')}
    </div>

    <div class="card course-editor">
      <button id="courseEditorToggleBtn" type="button" class="course-editor-toggle" aria-expanded="true">
        <span class="course-editor-chevron" aria-hidden="true">▸</span>
        <h3 style="margin:0">Courses edition</h3>
        <span class="helper">Edit course name, color and exam subsections.</span>
      </button>
      <div id="courseEditorBody" class="course-editor-body">
      <div class="course-edit-list">
        ${courses.map(course => {
          const sectionText = (sectionsByCourse[course.id] || []).map(section => section.name).join(', ');
          const safeColor = normalizeHexColor(course.color, '#B8B5FF');
          return `
          <div class="course-edit-row" data-course-id="${course.id}">
            <input type="text" class="course-edit-name" value="${escapeHtml(course.name)}" placeholder="Course name">
            <div class="course-color-wrap">
              <div class="preset-colors">${renderColorPresetButtons(safeColor)}</div>
              <input type="color" class="course-edit-color" value="${safeColor}" oninput="syncPresetFromInput(this)">
            </div>
            <input type="text" class="course-edit-sections" value="${escapeHtml(sectionText)}" placeholder="Subsections (comma separated)">
            <button type="button" onclick="saveCourse(this)">Save</button>
            <button type="button" class="btn-danger" onclick="deleteCourse(this)">Delete</button>
          </div>
        `;
        }).join('')}
        <div class="course-edit-row new-course">
          <input type="text" id="newCourseName" placeholder="New course name">
          <div class="course-color-wrap">
            <div class="preset-colors">${renderColorPresetButtons(BLOCUS_PASTELS[courses.length % BLOCUS_PASTELS.length])}</div>
            <input type="color" id="newCourseColor" value="${BLOCUS_PASTELS[courses.length % BLOCUS_PASTELS.length]}" oninput="syncPresetFromInput(this)">
          </div>
          <input type="text" id="newCourseSections" placeholder="Subsections (comma separated)">
          <button type="button" onclick="createCourse()">Add course</button>
        </div>
      </div>
      </div>
    </div>

    <h2 class="section-title">Upcoming days</h2>
    ${upcomingDays.length > 0 ? renderCalendarGrid(upcomingDays, true) : '<div class="card empty-calendar">No upcoming day left in this period.</div>'}

    ${pastDays.length > 0 ? `
      <div class="card past-days">
        <div class="row" style="margin-bottom:12px">
          <h3>Past days</h3>
          <span class="helper">${pastDays.length} archived day${pastDays.length === 1 ? '' : 's'}</span>
        </div>
        ${renderCalendarGrid(pastDays, false)}
      </div>
    ` : ''}

    <script>
      const BASE = location.pathname.startsWith('/todo') ? '/todo' : '';
      const blocusId = '${blocus.id}';
      const ENTRY_META = ${JSON.stringify(entryMeta)};
      const SECTION_TO_COURSE = ${JSON.stringify(sectionToCourse)};
      const MODE_STORAGE_KEY = 'blocus-mode:' + blocusId;
      const COURSE_EDITOR_STORAGE_KEY = 'blocus-course-editor-open:' + blocusId;
      const EXAM_OUTLINE = '${BLOCUS_EXAM_OUTLINE}';
      const selectedSlotKeys = new Set();
      let multiSelectEnabled = false;
      let editAutosaveInterval = null;
      const courseEditorToggleBtn = document.getElementById('courseEditorToggleBtn');
      const courseEditorBody = document.getElementById('courseEditorBody');

      function debugSave() {}

      function hexToRgb(hex) {
        const clean = (hex || '').replace('#', '');
        if (clean.length !== 6) return null;
        const value = parseInt(clean, 16);
        if (Number.isNaN(value)) return null;
        return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
      }

      function rgba(hex, alpha) {
        const rgb = hexToRgb(hex);
        if (!rgb) return '';
        return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + alpha + ')';
      }

      function darken(hex, amount) {
        const rgb = hexToRgb(hex);
        if (!rgb) return '';
        const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
        const r = clamp(rgb.r * (1 - amount));
        const g = clamp(rgb.g * (1 - amount));
        const b = clamp(rgb.b * (1 - amount));
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      }

      function normalizeExamTimeValue(raw) {
        const value = (raw || '').toString().trim();
        if (!value) return '';
        const match24 = value.match(/^(\\d{1,2}):([0-5]\\d)(?::[0-5]\\d)?$/);
        if (match24) {
          const hh = Number(match24[1]);
          if (hh >= 0 && hh <= 23) return String(hh).padStart(2, '0') + ':' + match24[2];
          return null;
        }

        const match12 = value.match(/^(\\d{1,2}):([0-5]\\d)(?::[0-5]\\d)?\\s*([AaPp][Mm])$/);
        if (match12) {
          let hh = Number(match12[1]);
          if (hh < 1 || hh > 12) return null;
          const mm = match12[2];
          const ampm = match12[3].toUpperCase();
          if (ampm === 'AM') hh = hh === 12 ? 0 : hh;
          if (ampm === 'PM') hh = hh === 12 ? 12 : hh + 12;
          return String(hh).padStart(2, '0') + ':' + mm;
        }

        return null;
      }

      function readExamTimeFromSelectors(slotEl, prefix) {
        const hourSelect = slotEl.querySelector('.slot-exam-' + prefix + '-hour');
        const minuteSelect = slotEl.querySelector('.slot-exam-' + prefix + '-minute');
        if (hourSelect || minuteSelect) {
          const hh = hourSelect ? hourSelect.value : '';
          const mm = minuteSelect ? minuteSelect.value : '';
          if (!hh && !mm) return '';
          if (!hh) return '';
          return normalizeExamTimeValue(hh + ':' + (mm || '00'));
        }

        const legacyInput = slotEl.querySelector('.slot-exam-' + prefix);
        if (!legacyInput) return '';
        return normalizeExamTimeValue(legacyInput.value);
      }

      function setExamTimeToSelectors(slotEl, prefix, value) {
        const normalized = normalizeExamTimeValue(value);
        const hourSelect = slotEl.querySelector('.slot-exam-' + prefix + '-hour');
        const minuteSelect = slotEl.querySelector('.slot-exam-' + prefix + '-minute');
        if (hourSelect || minuteSelect) {
          const parts = normalized ? normalized.split(':') : ['', '00'];
          if (hourSelect) hourSelect.value = parts[0] || '';
          if (minuteSelect) minuteSelect.value = parts[1] || '00';
          return;
        }

        const legacyInput = slotEl.querySelector('.slot-exam-' + prefix);
        if (legacyInput) legacyInput.value = normalized || '';
      }

      function relativeLuminance(hex) {
        const rgb = hexToRgb(hex);
        if (!rgb) return 0;
        const linear = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return (0.2126 * linear(rgb.r)) + (0.7152 * linear(rgb.g)) + (0.0722 * linear(rgb.b));
      }

      function setSlotTextTheme(slotEl, lightBackground, isExam) {
        if (lightBackground) {
          slotEl.style.setProperty('--slot-label-color', 'rgba(48,51,54,0.6)');
          slotEl.style.setProperty('--slot-main-color', '#303336');
          slotEl.style.setProperty('--slot-empty-color', 'rgba(48,51,54,0.5)');
          slotEl.style.setProperty('--slot-note-color', '#44474b');
          slotEl.style.setProperty('--slot-countdown-color', '#303336');
          slotEl.style.setProperty('--slot-divider-color', '#dfe3e8');
          slotEl.style.setProperty('--slot-badge-bg', isExam ? 'rgba(220,38,38,0.10)' : 'rgba(37,118,235,0.10)');
          slotEl.style.setProperty('--slot-badge-border', 'transparent');
          slotEl.style.setProperty('--slot-badge-color', isExam ? '#dc2626' : '#2576eb');
          return;
        }

        slotEl.style.setProperty('--slot-label-color', 'rgba(255,255,255,0.78)');
        slotEl.style.setProperty('--slot-main-color', '#ffffff');
        slotEl.style.setProperty('--slot-empty-color', 'rgba(255,255,255,0.62)');
        slotEl.style.setProperty('--slot-note-color', 'rgba(255,255,255,0.88)');
        slotEl.style.setProperty('--slot-countdown-color', '#ffffff');
        slotEl.style.setProperty('--slot-divider-color', 'rgba(255,255,255,0.22)');
        slotEl.style.setProperty('--slot-badge-bg', 'rgba(255,255,255,0.18)');
        slotEl.style.setProperty('--slot-badge-border', 'rgba(255,255,255,0.32)');
        slotEl.style.setProperty('--slot-badge-color', '#ffffff');
      }

      function applySlotTextThemeFromColor(slotEl, color, isExam) {
        if (!color) {
          setSlotTextTheme(slotEl, false, isExam);
          return;
        }
        const perceived = isExam ? darken(color, 0.24) : darken(color, 0.12);
        setSlotTextTheme(slotEl, relativeLuminance(perceived) > 0.46, isExam);
      }

      function parseEntry(value) {
        if (!value) return { courseId: '', sectionId: '' };
        const [kind, id] = value.split(':');
        if (kind === 'course') return { courseId: id, sectionId: '' };
        if (kind === 'section') return { courseId: SECTION_TO_COURSE[id] || '', sectionId: id };
        return { courseId: '', sectionId: '' };
      }

      function getSlotKey(slotEl) {
        return slotEl.dataset.day + '|' + slotEl.dataset.period;
      }

      function getSlotByKey(key) {
        const split = key.lastIndexOf('|');
        if (split <= 0) return null;
        const day = key.slice(0, split);
        const period = key.slice(split + 1);
        return document.querySelector('.calendar-slot[data-day="' + day + '"][data-period="' + period + '"]');
      }

      function normalizeHexColorValue(value) {
        const raw = (value || '').toString().trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return '';
        return (raw.startsWith('#') ? raw : '#' + raw).toLowerCase();
      }

      function refreshPresetButtons(container, color) {
        const normalized = normalizeHexColorValue(color);
        container.querySelectorAll('.preset-color-btn').forEach(btn => {
          btn.classList.toggle('active', normalizeHexColorValue(btn.dataset.color) === normalized);
        });
      }

      function applyPresetColor(btn, event) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        const container = btn.closest('.course-color-wrap');
        if (!container) return;
        const input = container.querySelector('input[type="color"]');
        const color = normalizeHexColorValue(btn.dataset.color);
        if (!input || !color) return;
        input.value = color;
        refreshPresetButtons(container, color);
      }

      function syncPresetFromInput(input) {
        const container = input.closest('.course-color-wrap');
        if (!container) return;
        refreshPresetButtons(container, input.value);
      }

      function getLocalTodayIso() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day;
      }

      function dayDiffLocal(fromIso, toIso) {
        const fromParts = (fromIso || '').split('-').map(Number);
        const toParts = (toIso || '').split('-').map(Number);
        if (fromParts.length !== 3 || toParts.length !== 3) return 0;
        const from = new Date(fromParts[0], fromParts[1] - 1, fromParts[2]);
        const to = new Date(toParts[0], toParts[1] - 1, toParts[2]);
        return Math.round((to.getTime() - from.getTime()) / 86400000);
      }

      function formatDaysLeft(diff) {
        if (diff > 0) return diff + ' day' + (diff === 1 ? '' : 's') + ' left';
        if (diff === 0) return 'Exam today';
        const ago = Math.abs(diff);
        return ago + ' day' + (ago === 1 ? '' : 's') + ' ago';
      }

      function buildExamTimeLabel(start, end) {
        if (start && end) return start + ' → ' + end;
        if (start) return start + ' →';
        if (end) return '→ ' + end;
        return '';
      }

      function getSlotState(slotEl) {
        const main = slotEl.querySelector('.slot-main').value;
        const isExam = main === '__exam__';
        const target = isExam ? slotEl.querySelector('.slot-exam-for').value : main;
        const note = isExam ? slotEl.querySelector('.slot-exam-note').value.trim() : '';
        const start = isExam ? readExamTimeFromSelectors(slotEl, 'start') : '';
        const end = isExam ? readExamTimeFromSelectors(slotEl, 'end') : '';
        return { isExam, target, note, start, end };
      }

      function buildSlotSavePayload(slotEl) {
        const { isExam, target, note, start, end } = getSlotState(slotEl);
        const lastStart = slotEl.dataset.lastSavedExamStart || '';
        const lastEnd = slotEl.dataset.lastSavedExamEnd || '';
        let safeStart = start === null ? '' : (start || '');
        let safeEnd = end === null ? '' : (end || '');
        if (isExam) {
          if (!safeStart && lastStart) safeStart = lastStart;
          if (!safeEnd && lastEnd) safeEnd = lastEnd;
        } else {
          safeStart = '';
          safeEnd = '';
        }
        const parsed = parseEntry(target);
        return {
          isExam,
          note,
          start: safeStart,
          end: safeEnd,
          courseId: parsed.courseId || '',
          sectionId: parsed.sectionId || ''
        };
      }

      function slotPayloadSignature(payload) {
        return [
          payload.isExam ? '1' : '0',
          payload.courseId,
          payload.sectionId,
          payload.note,
          payload.start,
          payload.end
        ].join('|');
      }

      function applyServerSlotSnapshot(day, slots) {
        if (!day || !slots || typeof slots !== 'object') return;
        ['morning', 'afternoon'].forEach(periodName => {
          const slotEl = getSlotByKey(day + '|' + periodName);
          if (!slotEl) return;
          const state = slots[periodName] || {};
          const isExam = Number(state.isExam) === 1;
          const targetValue = state.sectionId
            ? ('section:' + state.sectionId)
            : state.courseId
              ? ('course:' + state.courseId)
              : '';
          const mainInput = slotEl.querySelector('.slot-main');
          const examForInput = slotEl.querySelector('.slot-exam-for');
          const examNoteInput = slotEl.querySelector('.slot-exam-note');
          const examExtra = slotEl.querySelector('.exam-extra');

          if (mainInput) mainInput.value = isExam ? '__exam__' : targetValue;
          if (examForInput) examForInput.value = isExam ? targetValue : '';
          setExamTimeToSelectors(slotEl, 'start', isExam ? (state.examStartTime || '') : '');
          setExamTimeToSelectors(slotEl, 'end', isExam ? (state.examEndTime || '') : '');
          if (examNoteInput) examNoteInput.value = isExam ? (state.examNote || '') : '';
          if (examExtra) examExtra.classList.toggle('hidden', !isExam);
          refreshSlot(slotEl);

          const syncedPayload = buildSlotSavePayload(slotEl);
          slotEl.dataset.lastSavedExamStart = syncedPayload.isExam ? (syncedPayload.start || '') : '';
          slotEl.dataset.lastSavedExamEnd = syncedPayload.isExam ? (syncedPayload.end || '') : '';
          slotEl._lastSavedSignature = slotPayloadSignature(syncedPayload);
        });
      }

      function updateCountdown(countdownEl) {
        const examDate = countdownEl.dataset.examDate;
        if (!examDate) return;
        const diff = dayDiffLocal(getLocalTodayIso(), examDate);
        countdownEl.textContent = formatDaysLeft(diff);
      }

      function applySlotColor(slotEl) {
        const { isExam, target } = getSlotState(slotEl);
        const meta = ENTRY_META[target];
        const examOutline = rgba(EXAM_OUTLINE, 0.96) || 'rgba(250,145,137,0.96)';
        if (!meta || !meta.color) {
          applySlotTextThemeFromColor(slotEl, isExam ? EXAM_OUTLINE : null, isExam);
          slotEl.style.background = isExam
            ? darken(EXAM_OUTLINE, 0.24)
            : 'var(--surface-soft)';
          slotEl.style.borderColor = isExam ? examOutline : 'var(--border)';
          slotEl.style.outline = isExam ? '3px solid ' + examOutline : 'none';
          slotEl.style.outlineOffset = isExam ? '-2px' : '0';
          slotEl.style.boxShadow = isExam
            ? ('0 0 12px ' + (rgba(EXAM_OUTLINE, 0.2) || 'rgba(236,72,153,0.2)'))
            : 'none';
          return;
        }
        const base = meta.color;
        applySlotTextThemeFromColor(slotEl, base, isExam);
        slotEl.style.background = isExam
          ? ('linear-gradient(155deg,' + darken(base, 0.2) + ',' + darken(base, 0.32) + ')')
          : ('linear-gradient(155deg,' + darken(base, 0.08) + ',' + darken(base, 0.16) + ')');
        slotEl.style.borderColor = isExam ? examOutline : 'var(--border)';
        slotEl.style.outline = isExam ? '3px solid ' + examOutline : 'none';
        slotEl.style.outlineOffset = isExam ? '-2px' : '0';
        slotEl.style.boxShadow = isExam
          ? ('0 0 14px ' + rgba(base, 0.18))
          : 'none';
      }

      function updateSlotView(slotEl) {
        const { isExam, target, note, start, end } = getSlotState(slotEl);
        const meta = ENTRY_META[target];
        const timeLabel = isExam ? buildExamTimeLabel(start, end) : '';
        const main = slotEl.querySelector('.slot-view-main');
        const labelTimeEl = slotEl.querySelector('.calendar-slot-label-time');
        const noteEl = slotEl.querySelector('.slot-view-note');
        const countdownEl = slotEl.querySelector('.slot-countdown');

        main.textContent = meta ? meta.label : 'No course selected';
        main.classList.toggle('slot-view-empty', !meta);
        if (labelTimeEl) {
          labelTimeEl.classList.toggle('hidden', !timeLabel);
          labelTimeEl.textContent = timeLabel;
        }
        noteEl.classList.toggle('hidden', !(isExam && note));
        noteEl.textContent = isExam && note ? note : '';
        countdownEl.classList.toggle('hidden', !isExam);
        if (isExam) updateCountdown(countdownEl);
      }

      function refreshSlot(slotEl) {
        applySlotColor(slotEl);
        updateSlotView(slotEl);
      }

      function updateSlotSelectorLabel(slotEl, isSelected) {
        const selector = slotEl.querySelector('.slot-selector');
        if (selector) selector.textContent = isSelected ? 'Selected' : 'Select';
      }

      function setSlotSelected(slotEl, selected) {
        const key = getSlotKey(slotEl);
        if (selected) {
          selectedSlotKeys.add(key);
          slotEl.classList.add('selected');
        } else {
          selectedSlotKeys.delete(key);
          slotEl.classList.remove('selected');
        }
        updateSlotSelectorLabel(slotEl, selected);
      }

      function clearBatchSelection(refresh = true) {
        selectedSlotKeys.forEach(key => {
          const slotEl = getSlotByKey(key);
          if (slotEl) {
            slotEl.classList.remove('selected');
            updateSlotSelectorLabel(slotEl, false);
          }
        });
        selectedSlotKeys.clear();
        if (refresh) updateBatchUi();
      }

      function updateBatchUi() {
        const count = selectedSlotKeys.size;
        multiSelectCount.textContent = count + ' selected';
        multiSelectToggle.classList.toggle('active', multiSelectEnabled);
        multiSelectToggle.textContent = multiSelectEnabled ? 'Disable multi-select' : 'Enable multi-select';
        batchApplyBtn.disabled = count === 0 || !batchTargetSelect.value;
        batchClearSelectionBtn.disabled = count === 0;
        document.querySelectorAll('.calendar-slot').forEach(slotEl => {
          slotEl.classList.toggle('selectable', multiSelectEnabled && document.body.dataset.blocusMode === 'edit');
        });
      }

      function toggleSlotSelection(slotEl) {
        const key = getSlotKey(slotEl);
        const nextSelected = !selectedSlotKeys.has(key);
        setSlotSelected(slotEl, nextSelected);
        updateBatchUi();
      }

      function toggleSlotSelectionByButton(button, event) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (!multiSelectEnabled || document.body.dataset.blocusMode !== 'edit') return;
        const slotEl = button.closest('.calendar-slot');
        if (!slotEl) return;
        toggleSlotSelection(slotEl);
      }

      function handleSlotTileClick(event) {
        if (!multiSelectEnabled || document.body.dataset.blocusMode !== 'edit') return;
        if (event.target.closest('select,input,textarea,button,label,option')) return;
        event.preventDefault();
        toggleSlotSelection(event.currentTarget);
      }

      async function saveSlot(slotEl, { silent = false } = {}) {
        if (!slotEl) return false;
        const payload = buildSlotSavePayload(slotEl);
        const signature = slotPayloadSignature(payload);
        if (slotEl._lastSavedSignature === signature) {
          debugSave('save skip unchanged', slotEl);
          return true;
        }
        const nextVersion = Math.max((slotEl._saveVersion || 0) + 1, Date.now() * 1000);
        slotEl._saveVersion = nextVersion;
        const target = payload.sectionId
          ? ('section:' + payload.sectionId)
          : payload.courseId
            ? ('course:' + payload.courseId)
            : 'none';
        debugSave(
          'save send',
          slotEl,
          'v=' + nextVersion + ' exam=' + (payload.isExam ? '1' : '0') + ' target=' + target + ' start=' + (payload.start || '∅') + ' end=' + (payload.end || '∅')
        );

        const fd = new FormData();
        fd.append('blocusId', blocusId);
        fd.append('day', slotEl.dataset.day);
        fd.append('period', slotEl.dataset.period);
        fd.append('courseId', payload.courseId);
        fd.append('sectionId', payload.sectionId);
        fd.append('isExam', payload.isExam ? '1' : '0');
        fd.append('examNote', payload.note);
        fd.append('examStartTime', payload.start);
        fd.append('examEndTime', payload.end);
        fd.append('clientUpdatedAt', String(nextVersion));

        const response = await fetch(BASE + '/api/blocus/slot/update', { method: 'POST', body: fd, keepalive: true });
        if (!response.ok) {
          const message = await response.text() || 'Could not save slot.';
          debugSave('save failed', slotEl, 'status=' + response.status + ' message=' + message);
          if (!silent) alert(message);
          return false;
        }
        let responseJson = null;
        try {
          responseJson = await response.json();
        } catch {
          responseJson = null;
        }
        if (responseJson && responseJson.day && responseJson.slots) {
          applyServerSlotSnapshot(responseJson.day, responseJson.slots);
          debugSave('save ok', slotEl, 'v=' + nextVersion + ' synced day=' + responseJson.day);
          return true;
        }
        if (payload.isExam) {
          slotEl.dataset.lastSavedExamStart = payload.start || '';
          slotEl.dataset.lastSavedExamEnd = payload.end || '';
        } else {
          slotEl.dataset.lastSavedExamStart = '';
          slotEl.dataset.lastSavedExamEnd = '';
        }
        slotEl._lastSavedSignature = signature;
        debugSave('save ok', slotEl, 'v=' + nextVersion + ' start=' + (payload.start || '∅') + ' end=' + (payload.end || '∅'));
        return true;
      }

      function handleSlotChange(input) {
        const slotEl = input.closest('.calendar-slot');
        const isExam = input.value === '__exam__';
        slotEl.querySelector('.exam-extra').classList.toggle('hidden', !isExam);
        refreshSlot(slotEl);
        debugSave('input main change', slotEl, 'value=' + input.value);
        queueSlotSave(slotEl, 0);
      }

      function queueSlotSave(slotEl, delay = 0) {
        if (!slotEl) return;
        if (slotEl._saveTimer) {
          clearTimeout(slotEl._saveTimer);
          slotEl._saveTimer = null;
        }
        if (delay > 0) {
          slotEl._saveTimer = setTimeout(() => {
            slotEl._saveTimer = null;
            saveSlot(slotEl);
          }, delay);
          debugSave('save queued', slotEl, 'delay=' + delay + 'ms');
          return;
        }
        debugSave('save queued', slotEl, 'delay=0ms');
        saveSlot(slotEl);
      }

      function saveSlotFromInput(input, defer = false) {
        const slotEl = input.closest('.calendar-slot');
        refreshSlot(slotEl);
        debugSave('input change', slotEl, 'field=' + input.className + ' value=' + (input.value || ''));
        queueSlotSave(slotEl, defer ? 260 : 0);
      }

      function persistDirtySlots(source = 'manual') {
        let dirty = 0;
        document.querySelectorAll('.calendar-slot').forEach(slotEl => {
          if (slotEl._saveTimer) {
            clearTimeout(slotEl._saveTimer);
            slotEl._saveTimer = null;
          }
          const currentSignature = slotPayloadSignature(buildSlotSavePayload(slotEl));
          if (currentSignature !== slotEl._lastSavedSignature) {
            dirty += 1;
            saveSlot(slotEl, { silent: true });
          }
        });
        debugSave('persist dirty', null, 'source=' + source + ' dirty=' + dirty);
      }

      function startEditAutosave() {
        if (editAutosaveInterval) return;
        editAutosaveInterval = setInterval(() => persistDirtySlots('interval'), 1200);
        debugSave('autosave start');
      }

      function stopEditAutosave() {
        if (!editAutosaveInterval) return;
        clearInterval(editAutosaveInterval);
        editAutosaveInterval = null;
        debugSave('autosave stop');
      }

      async function applyBatchAssignment() {
        const rawTarget = batchTargetSelect.value;
        if (!rawTarget || selectedSlotKeys.size === 0) return;

        const targetValue = rawTarget === '__clear__' ? '' : rawTarget;
        const selectedSlots = Array.from(selectedSlotKeys).map(getSlotByKey).filter(Boolean);
        if (selectedSlots.length === 0) return;

        selectedSlots.forEach(slotEl => {
          slotEl.querySelector('.slot-main').value = targetValue;
          slotEl.querySelector('.slot-exam-for').value = '';
          setExamTimeToSelectors(slotEl, 'start', '');
          setExamTimeToSelectors(slotEl, 'end', '');
          slotEl.querySelector('.slot-exam-note').value = '';
          slotEl.querySelector('.exam-extra').classList.add('hidden');
          refreshSlot(slotEl);
        });

        batchApplyBtn.disabled = true;
        const results = await Promise.all(selectedSlots.map(slotEl => saveSlot(slotEl, { silent: true })));
        const failed = results.filter(ok => !ok).length;
        if (failed > 0) {
          alert(failed + ' slot' + (failed === 1 ? '' : 's') + ' failed to save.');
        }

        clearBatchSelection(false);
        batchTargetSelect.value = '';
        updateBatchUi();
      }

      function parseSectionsInput(raw) {
        const seen = new Set();
        return (raw || '')
          .split(',')
          .map(section => section.trim())
          .filter(Boolean)
          .filter(section => {
            const key = section.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 12);
      }

      function setMode(mode) {
        const previousMode = document.body.dataset.blocusMode || 'view';
        const normalized = mode === 'edit' ? 'edit' : 'view';
        if (normalized !== 'edit') {
          multiSelectEnabled = false;
          clearBatchSelection(false);
        }
        if (normalized === 'edit') {
          startEditAutosave();
        } else {
          stopEditAutosave();
          if (previousMode === 'edit') persistDirtySlots('mode-switch');
          document.querySelectorAll('.calendar-slot').forEach(refreshSlot);
        }
        document.body.dataset.blocusMode = normalized;
        modeViewBtn.classList.toggle('active', normalized === 'view');
        modeEditBtn.classList.toggle('active', normalized === 'edit');
        localStorage.setItem(MODE_STORAGE_KEY, normalized);
        updateBatchUi();
      }

      function setCourseEditorOpen(open) {
        if (!courseEditorToggleBtn || !courseEditorBody) return;
        courseEditorToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        courseEditorBody.classList.toggle('hidden', !open);
        localStorage.setItem(COURSE_EDITOR_STORAGE_KEY, open ? '1' : '0');
      }

      async function createCourse() {
        const name = (newCourseName.value || '').trim();
        if (!name) {
          newCourseName.focus();
          return;
        }
        const sections = parseSectionsInput(newCourseSections.value);
        const fd = new FormData();
        fd.append('blocusId', blocusId);
        fd.append('name', name);
        fd.append('color', newCourseColor.value || '');
        fd.append('sections', JSON.stringify(sections));
        const response = await fetch(BASE + '/api/blocus/course/create', { method: 'POST', body: fd });
        if (!response.ok) {
          alert(await response.text() || 'Could not create course.');
          return;
        }
        location.reload();
      }

      async function saveCourse(btn) {
        const row = btn.closest('.course-edit-row');
        const name = (row.querySelector('.course-edit-name').value || '').trim();
        if (!name) {
          row.querySelector('.course-edit-name').focus();
          return;
        }
        const fd = new FormData();
        fd.append('blocusId', blocusId);
        fd.append('courseId', row.dataset.courseId);
        fd.append('name', name);
        fd.append('color', row.querySelector('.course-edit-color').value || '');
        fd.append('sections', JSON.stringify(parseSectionsInput(row.querySelector('.course-edit-sections').value)));
        const response = await fetch(BASE + '/api/blocus/course/update', { method: 'POST', body: fd });
        if (!response.ok) {
          alert(await response.text() || 'Could not update course.');
          return;
        }
        location.reload();
      }

      async function deleteCourse(btn) {
        const row = btn.closest('.course-edit-row');
        if (!confirm('Delete this course and its subsections?')) return;
        const fd = new FormData();
        fd.append('blocusId', blocusId);
        fd.append('courseId', row.dataset.courseId);
        const response = await fetch(BASE + '/api/blocus/course/delete', { method: 'POST', body: fd });
        if (!response.ok) {
          alert(await response.text() || 'Could not delete course.');
          return;
        }
        location.reload();
      }

      modeViewBtn.addEventListener('click', () => setMode('view'));
      modeEditBtn.addEventListener('click', () => setMode('edit'));
      if (courseEditorToggleBtn && courseEditorBody) {
        const initialCourseEditorOpen = localStorage.getItem(COURSE_EDITOR_STORAGE_KEY);
        setCourseEditorOpen(initialCourseEditorOpen !== '0');
        courseEditorToggleBtn.addEventListener('click', () => {
          const isOpen = courseEditorToggleBtn.getAttribute('aria-expanded') === 'true';
          setCourseEditorOpen(!isOpen);
        });
      }
      multiSelectToggle.addEventListener('click', () => {
        if (document.body.dataset.blocusMode !== 'edit') return;
        multiSelectEnabled = !multiSelectEnabled;
        if (!multiSelectEnabled) clearBatchSelection(false);
        updateBatchUi();
      });
      batchTargetSelect.addEventListener('change', updateBatchUi);
      batchApplyBtn.addEventListener('click', applyBatchAssignment);
      batchClearSelectionBtn.addEventListener('click', () => clearBatchSelection());

      const initialMode = localStorage.getItem(MODE_STORAGE_KEY) || 'view';
      setMode(initialMode);
      const allSlots = Array.from(document.querySelectorAll('.calendar-slot'));
      allSlots.forEach(slotEl => {
        refreshSlot(slotEl);
        const initialPayload = buildSlotSavePayload(slotEl);
        slotEl.dataset.lastSavedExamStart = initialPayload.isExam ? (initialPayload.start || '') : '';
        slotEl.dataset.lastSavedExamEnd = initialPayload.isExam ? (initialPayload.end || '') : '';
        slotEl._lastSavedSignature = slotPayloadSignature(initialPayload);
        updateSlotSelectorLabel(slotEl, false);
        slotEl.addEventListener('click', handleSlotTileClick);
      });
      debugSave('debug initialized', null, 'slots=' + allSlots.length);
      document.querySelectorAll('.course-color-wrap input[type="color"]').forEach(syncPresetFromInput);
      document.querySelectorAll('.slot-countdown:not(.hidden)').forEach(updateCountdown);
    </script>
  </body></html>`;
}

function renderBoard(user, board, lists, cards, basePath = '') {
  const cardsByList = {};
  cards.forEach(c => {
    if (!cardsByList[c.list_id]) cardsByList[c.list_id] = [];
    cardsByList[c.list_id].push(c);
  });

  return `<!DOCTYPE html><html lang="en"><head><title>${board.name} · 111iridescence</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body class="full">
    <header>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        ${renderBrand()}
        <span style="color:var(--border);font-size:1.2em">/</span>
        <a href="${basePath}/" style="color:var(--txt-muted);text-decoration:none;font-size:0.95em;transition:color 0.2s" onmouseover="this.style.color='var(--txt-main)'" onmouseout="this.style.color='var(--txt-muted)'">Boards</a>
        <span style="color:var(--border);font-size:1.2em">/</span>
        <strong style="color:var(--txt-main);font-size:0.95em">${board.name}</strong>
      </div>
      ${renderNav('', user, basePath)}
    </header>

  <div class="page-hero" style="margin:32px 0 24px">
    <h1 style="font-size:28px">${escapeHtml(board.name)}</h1>
    <div class="toolbar"><button onclick="showListModal()">New list</button></div>
  </div>

  <div class="kanban" ondrop="dropList(event)" ondragover="dragOverList(event)">
    ${lists.map(list => `
        <div class="list" data-list-id="${list.id}" draggable="true" ondragstart="dragList(event,'${list.id}')" ondragend="dragEndList(event)">
          <div class="list-header" style="cursor:grab">
            <input value="${list.name}" onblur="renameList('${list.id}',this.value)" ondragstart="event.stopPropagation()" draggable="false">
            <span class="count">${(cardsByList[list.id] || []).length}</span>
            <button onclick="deleteList('${list.id}','${list.name}')" ondragstart="event.stopPropagation()">🗑</button>
          </div>
          <div class="cards" ondrop="drop(event,'${list.id}')" ondragover="allowDrop(event)">
            ${(cardsByList[list.id] || []).map(card => `
              <div class="task-card" draggable="true" ondragstart="drag(event,'${card.id}')" data-card-id="${card.id}">
                <div class="card-title">${card.title}</div>
                ${card.description ? `<div class="card-desc">${card.description}</div>` : ''}
                <div class="card-actions">
                  <button onmousedown="event.stopPropagation()" onclick="event.stopPropagation();editCard('${card.id}','${escapeHtml(card.title)}','${escapeHtml(card.description)}')">Edit</button>
                  <button class="del" onmousedown="event.stopPropagation()" onclick="event.stopPropagation();deleteCard('${card.id}')">Delete</button>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="add-card" onclick="showCardModal('${list.id}')" ondragstart="event.stopPropagation()">+ Add Card</div>
        </div>
      `).join('')}
  </div>

  <!-- List Modal -->
  <div id="listModal" class="modal">
    <div class="modal-content">
      <h3>Create List</h3>
      <form onsubmit="event.preventDefault();createList(this)">
        <div class="form-group">
          <label>List Name</label>
          <input type="text" name="name" required autofocus>
        </div>
        <div class="btn-group">
          <button>Create</button>
          <button type="button" class="btn-danger" onclick="hideModals()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Card Modal -->
  <div id="cardModal" class="modal">
    <div class="modal-content">
      <h3>Create Card</h3>
      <form onsubmit="event.preventDefault();createCard(this)">
        <input type="hidden" name="listId" id="cardListId">
          <div class="form-group">
            <label>Card Title</label>
            <input type="text" name="title" required>
          </div>
          <div class="btn-group">
            <button>Create</button>
            <button type="button" class="btn-danger" onclick="hideModals()">Cancel</button>
          </div>
      </form>
    </div>
  </div>

  <!-- Edit Card Modal -->
  <div id="editModal" class="modal">
    <div class="modal-content">
      <h3>Edit Card</h3>
      <form onsubmit="event.preventDefault();updateCard(this)">
        <input type="hidden" name="id" id="editCardId">
          <div class="form-group">
            <label>Title</label>
            <input type="text" name="title" id="editTitle" required>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea name="description" id="editDesc" rows="4"></textarea>
          </div>
          <div class="btn-group">
            <button>Save</button>
            <button type="button" class="btn-danger" onclick="hideModals()">Cancel</button>
          </div>
      </form>
    </div>
  </div>

  <!-- Confirmation Modal -->
  <div id="confirmModal" class="modal">
    <div class="modal-content" style="max-width:400px">
      <h3>⚠ Confirm Deletion</h3>
      <p id="confirmMessage" style="color:#44474b;margin:20px 0"></p>
      <div class="btn-group">
        <button id="confirmYes" class="btn-danger">Delete</button>
        <button id="confirmNo" onclick="hideConfirm()">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    const BASE = location.pathname.startsWith('/todo') ? '/todo' : '';
    const boardId = '${board.id}';
    let draggedCardId = null;
    let draggedListId = null;
    let confirmCallback = null;

    function showConfirm(message, onConfirm) {
      confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.add('active');
      }

    function hideConfirm() {
      confirmModal.classList.remove('active');
    confirmCallback = null;
      }

      confirmYes.onclick = () => {
        if (confirmCallback) confirmCallback();
    hideConfirm();
      };

    function showListModal(){listModal.classList.add('active'); }
    function showCardModal(listId){cardListId.value = listId; cardModal.classList.add('active'); }
    function hideModals(){document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); }

    async function createList(f){
        const fd = new FormData(f);
    fd.append('boardId', boardId);
    await fetch(BASE + '/api/list/create',{method:'POST',body:fd});
    location.reload();
      }

    function deleteList(id, name){
      showConfirm('Delete list "' + name + '"? All cards will be deleted.', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/list/delete', { method: 'POST', body: fd });
        location.reload();
      });
      }

    async function renameList(id, name){
        const fd = new FormData();
    fd.append('id', id);
    fd.append('name', name);
    await fetch(BASE + '/api/list/rename',{method:'POST',body:fd});
      }

    async function createCard(f){
      await fetch(BASE + '/api/card/create', { method: 'POST', body: new FormData(f) });
    location.reload();
      }

    function editCard(id, title, desc){
      editCardId.value = id;
    editTitle.value = title;
    editDesc.value = desc;
    editModal.classList.add('active');
      }

    async function updateCard(f){
      await fetch(BASE + '/api/card/update', { method: 'POST', body: new FormData(f) });
    location.reload();
      }

    function deleteCard(id){
      showConfirm('Delete this card?', async () => {
        const fd = new FormData();
        fd.append('id', id);
        await fetch(BASE + '/api/card/delete', { method: 'POST', body: fd });
        location.reload();
      });
      }

    // Card drag and drop
    function drag(e, cardId){
      draggedCardId = cardId;
    e.target.classList.add('dragging');
    e.stopPropagation();
      }

    function allowDrop(e){e.preventDefault(); }

    async function drop(e, newListId){
      e.preventDefault();
    e.stopPropagation();
    if (!draggedCardId) return;

    const cardsContainer = e.currentTarget;
    const cards = Array.from(cardsContainer.children);
    const dropY = e.clientY;
    let newPosition = 0;

    for(let i = 0; i < cards.length; i++){
          const rect = cards[i].getBoundingClientRect();
    if(dropY < rect.top + rect.height / 2){
      newPosition = i;
    break;
          }
    newPosition = i + 1;
        }

    const fd = new FormData();
    fd.append('cardId', draggedCardId);
    fd.append('newListId', newListId);
    fd.append('newPosition', newPosition);
    await fetch(BASE + '/api/card/move',{method:'POST',body:fd});
    draggedCardId = null;
    location.reload();
      }

    // List drag and drop with live preview
    let draggedListElement = null;
    let placeholderElement = null;

    function dragList(e, listId){
      draggedListId = listId;
    draggedListElement = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';

    // Create placeholder
    placeholderElement = document.createElement('div');
    placeholderElement.className = 'list placeholder';
    placeholderElement.innerHTML = '<div style="padding:20px;text-align:center;color:var(--p);opacity:0.5">Drop here</div>';
      }

    function dragOverList(e){
      e.preventDefault();
    if (!draggedListId || !placeholderElement) return;

    const kanban = e.currentTarget;
    const afterElement = getDragAfterElement(kanban, e.clientX);

    // Insert placeholder at the right position
    if (afterElement == null) {
      kanban.appendChild(placeholderElement);
        } else {
      kanban.insertBefore(placeholderElement, afterElement);
        }
      }

    function getDragAfterElement(container, x) {
        const draggableElements = [...container.querySelectorAll('.list:not(.dragging):not(.placeholder)')];
        
        return draggableElements.reduce((closest, child) => {
          const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;

    if (offset < 0 && offset > closest.offset) {
            return {offset: offset, element: child };
          } else {
            return closest;
          }
        }, {offset: Number.NEGATIVE_INFINITY }).element;
      }

    async function dropList(e){
      e.preventDefault();
    if (!draggedListId || !placeholderElement) return;

    const kanban = e.currentTarget;
    const lists = Array.from(kanban.querySelectorAll('.list:not(.dragging):not(.placeholder)'));

    // Find position of placeholder
    let newPosition = 0;
    const allChildren = Array.from(kanban.children);
    const placeholderIndex = allChildren.indexOf(placeholderElement);

    // Count non-dragging, non-placeholder lists before the placeholder
    for(let i = 0; i < placeholderIndex; i++){
          if (!allChildren[i].classList.contains('dragging') && !allChildren[i].classList.contains('placeholder')) {
      newPosition++;
          }
        }

    // Clean up
    if (placeholderElement.parentNode) {
      placeholderElement.parentNode.removeChild(placeholderElement);
        }
    draggedListElement.classList.remove('dragging');

    const fd = new FormData();
    fd.append('listId', draggedListId);
    fd.append('newPosition', newPosition);
    await fetch(BASE + '/api/list/reorder',{method:'POST',body:fd});

    draggedListId = null;
    draggedListElement = null;
    placeholderElement = null;
    location.reload();
      }

    function dragEndList(e){
      e.target.classList.remove('dragging');
    if (placeholderElement && placeholderElement.parentNode) {
      placeholderElement.parentNode.removeChild(placeholderElement);
        }
    draggedListId = null;
    draggedListElement = null;
    placeholderElement = null;
      }
  </script>
</body></html>`;
}

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeHexColor(color, fallback = '#B8B5FF') {
  const value = typeof color === 'string' ? color.trim() : '';
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function normalizeExamTime(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const match24 = raw.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);
  if (match24) {
    const hh = Number(match24[1]);
    if (hh < 0 || hh > 23) return null;
    return `${String(hh).padStart(2, '0')}:${match24[2]}`;
  }

  const match12 = raw.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*([AaPp][Mm])$/);
  if (match12) {
    let hh = Number(match12[1]);
    if (hh < 1 || hh > 12) return null;
    const mm = match12[2];
    const ampm = match12[3].toUpperCase();
    if (ampm === 'AM') hh = hh === 12 ? 0 : hh;
    if (ampm === 'PM') hh = hh === 12 ? 12 : hh + 12;
    return `${String(hh).padStart(2, '0')}:${mm}`;
  }

  return null;
}

function normalizeBlocusCourses(courses) {
  if (!Array.isArray(courses)) return [];
  const normalized = [];
  for (let i = 0; i < courses.length; i++) {
    const course = courses[i] || {};
    const name = (course.name || '').toString().trim();
    if (!name) continue;

    const fallbackColor = BLOCUS_PASTELS[normalized.length % BLOCUS_PASTELS.length];
    const color = normalizeHexColor(course.color, fallbackColor);
    const sections = normalizeBlocusSectionNames(course.sections);

    normalized.push({ name, color, sections });
  }
  return normalized.slice(0, 24);
}

function normalizeBlocusSectionNames(sections) {
  if (!Array.isArray(sections)) return [];
  const seen = new Set();
  return sections
    .map(s => (s || '').toString().trim())
    .filter(Boolean)
    .filter(name => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

async function syncBlocusCourseSections(db, blocusId, courseId, username, sectionNames) {
  const targetSections = normalizeBlocusSectionNames(sectionNames);
  const { results: existing } = await db.prepare(
    'SELECT id, name, position FROM blocus_course_sections WHERE course_id = ? AND blocus_id = ? AND username = ? ORDER BY position ASC'
  ).bind(courseId, blocusId, username).all();

  const existingByKey = new Map();
  existing.forEach(section => {
    const key = section.name.trim().toLowerCase();
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(section);
  });

  const keptIds = new Set();
  for (let i = 0; i < targetSections.length; i++) {
    const name = targetSections[i];
    const key = name.toLowerCase();
    const candidates = existingByKey.get(key) || [];
    const reusable = candidates.find(section => !keptIds.has(section.id));

    if (reusable) {
      keptIds.add(reusable.id);
      if (reusable.name !== name || Number(reusable.position) !== i) {
        await db.prepare(
          'UPDATE blocus_course_sections SET name = ?, position = ? WHERE id = ?'
        ).bind(name, i, reusable.id).run();
      }
      continue;
    }

    await db.prepare(
      'INSERT INTO blocus_course_sections (id, blocus_id, course_id, username, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), blocusId, courseId, username, name, i, Date.now()).run();
  }

  for (let i = 0; i < existing.length; i++) {
    if (!keptIds.has(existing[i].id)) {
      await db.prepare('DELETE FROM blocus_course_sections WHERE id = ?').bind(existing[i].id).run();
    }
  }
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function toIsoDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isWithinFourMonths(start, end) {
  if (!start || !end) return false;
  if (end < start) return false;
  const maxEnd = new Date(start.getTime());
  maxEnd.setUTCMonth(maxEnd.getUTCMonth() + 4);
  maxEnd.setUTCDate(maxEnd.getUTCDate() - 1);
  return end <= maxEnd;
}

function isDateInRange(targetIso, startIso, endIso) {
  const target = parseIsoDate(targetIso);
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!target || !start || !end) return false;
  return target >= start && target <= end;
}

function buildDateRange(startIso, endIso) {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end || end < start) return [];

  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
  const days = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    days.push({
      iso: toIsoDate(cursor),
      weekday: weekdayFmt.format(cursor),
      day: String(cursor.getUTCDate()).padStart(2, '0')
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function dayDiffBetweenIso(fromIso, toIso) {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function formatDaysLeft(diff) {
  if (diff > 0) return `${diff} day${diff === 1 ? '' : 's'} left`;
  if (diff === 0) return 'Exam today';
  const ago = Math.abs(diff);
  return `${ago} day${ago === 1 ? '' : 's'} ago`;
}

function hexToRgb(hex) {
  const clean = (hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const value = parseInt(clean, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgbaFromHex(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function darkenHex(hex, amount = 0.2) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(rgb.r * (1 - amount));
  const g = clamp(rgb.g * (1 - amount));
  const b = clamp(rgb.b * (1 - amount));
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function getSlotStyle(color, isExam) {
  const examOutline = rgbaFromHex(BLOCUS_EXAM_OUTLINE, 0.96);
  if (!color) {
    if (!isExam) return '';
    return `background:${darkenHex(BLOCUS_EXAM_OUTLINE, 0.24)};border-color:${examOutline};outline:3px solid ${examOutline};outline-offset:-2px;box-shadow:0 0 12px ${rgbaFromHex(BLOCUS_EXAM_OUTLINE, 0.2)};`;
  }
  const bg = isExam
    ? `linear-gradient(155deg,${darkenHex(color, 0.2)},${darkenHex(color, 0.32)})`
    : `linear-gradient(155deg,${darkenHex(color, 0.08)},${darkenHex(color, 0.16)})`;
  const borderColor = isExam ? examOutline : 'var(--border)';
  const outlineStyle = isExam ? `outline:3px solid ${examOutline};outline-offset:-2px;` : 'outline:none;outline-offset:0;';
  const shadowStyle = isExam
    ? `box-shadow:0 0 14px ${rgbaFromHex(color, 0.18)};`
    : 'box-shadow:none;';
  return `background:${bg};border-color:${borderColor};${outlineStyle}${shadowStyle}`;
}
