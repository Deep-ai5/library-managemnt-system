/* =====================================================================
   College Library Management System
   Part 1: date helpers   Part 2: library service (all business rules)
   Part 3: test suite     Part 4: user interface
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Part 1: constants and helpers
     ------------------------------------------------------------------ */
  const STORAGE_KEY = 'lms.v1';
  const LOAN_DAYS = 14;
  const MAX_BOOKS = 3;
  const FINE_PER_DAY = 2;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const localISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const utcMs = (iso) => { const p = iso.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  const daysBetween = (a, b) => Math.round((utcMs(b) - utcMs(a)) / 86400000);
  const addDays = (iso, n) => {
    const d = new Date(utcMs(iso) + n * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const p = iso.split('-');
    return p[2] + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
  };
  const money = (n) => '₹' + n;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const normIsbn = (v) => clean(v).replace(/[\s-]/g, '').toUpperCase();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ok = (data) => ({ ok: true, data: data });
  const fail = (error) => ({ ok: false, error: error });

  /* Pure helper: table body HTML, or a single "empty" row when there is nothing to show. */
  function tableBody(rows, colspan, emptyText) {
    if (!rows.length) {
      return '<tr class="empty-row"><td colspan="' + colspan + '">' + esc(emptyText) + '</td></tr>';
    }
    return rows.join('');
  }

  /* ------------------------------------------------------------------
     Part 2: library service
     storage must offer getItem / setItem. clock must offer today().
     ------------------------------------------------------------------ */
  function createLibrary(storage, clock) {
    clock = clock || { today: () => localISO(new Date()) };

    const emptyDb = () => ({ books: [], students: [], loans: [], seq: { book: 1, loan: 1 } });
    let db = load();

    function load() {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          if (d && Array.isArray(d.books) && Array.isArray(d.students) && Array.isArray(d.loans)) {
            const base = emptyDb();
            return { books: d.books, students: d.students, loans: d.loans, seq: Object.assign(base.seq, d.seq) };
          }
        }
      } catch (e) { /* corrupt data: start fresh */ }
      return emptyDb();
    }

    function save() {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(db)); return true; }
      catch (e) { return false; }
    }

    /* ----- lookups ----- */
    const getBook = (id) => db.books.find((b) => b.id === id) || null;
    const getStudent = (id) => db.students.find((s) => s.id === id) || null;
    const getLoan = (id) => db.loans.find((l) => l.id === id) || null;

    const activeLoansOfBook = (bookId) => db.loans.filter((l) => l.bookId === bookId && !l.returnDate);
    const activeLoansOfStudent = (sid) => db.loans.filter((l) => l.studentId === sid && !l.returnDate);
    const unpaidLoansOfStudent = (sid) => db.loans.filter((l) => l.studentId === sid && l.fineStatus === 'unpaid');

    const borrowedCount = (bookId) => activeLoansOfBook(bookId).length;
    const availableOf = (book) => book.copies - borrowedCount(book.id);
    const fineDue = (sid) => unpaidLoansOfStudent(sid).reduce((sum, l) => sum + l.fine, 0);

    /* A loan plus values worked out for today's date. */
    function describeLoan(l) {
      const today = clock.today();
      if (!l.returnDate) {
        const late = Math.max(0, daysBetween(l.dueDate, today));
        return Object.assign({}, l, {
          active: true, overdue: late > 0, overdueDays: late,
          accrued: late * FINE_PER_DAY, daysLeft: daysBetween(today, l.dueDate),
          bookRemoved: !getBook(l.bookId)
        });
      }
      return Object.assign({}, l, {
        active: false, overdue: false, overdueDays: l.lateDays || 0,
        accrued: l.fine, daysLeft: 0, bookRemoved: !getBook(l.bookId)
      });
    }

    /* ----- validation ----- */
    const BOOK_LABELS = { isbn: 'ISBN', title: 'Title', author: 'Author', category: 'Category', copies: 'Copies' };

    function cleanBook(input) {
      const v = {};
      const missing = [];
      ['isbn', 'title', 'author', 'category'].forEach((k) => {
        v[k] = clean(input[k]);
        if (!v[k]) missing.push(BOOK_LABELS[k]);
      });
      const copiesRaw = clean(input.copies);
      if (!copiesRaw) missing.push(BOOK_LABELS.copies);
      if (missing.length) return fail('Please fill in: ' + missing.join(', ') + '.');

      v.isbn = normIsbn(v.isbn);
      if (!/^(\d{9}[\dX]|\d{13})$/.test(v.isbn)) {
        return fail('ISBN must have 10 or 13 characters (digits only; a 10-character ISBN may end in X).');
      }
      if (!/^\d+$/.test(copiesRaw) || Number(copiesRaw) < 1 || Number(copiesRaw) > 999) {
        return fail('Copies must be a whole number between 1 and 999.');
      }
      v.copies = Number(copiesRaw);
      return ok(v);
    }

    const STUDENT_LABELS = { id: 'Student ID', name: 'Name', department: 'Department', email: 'Email' };

    function cleanStudent(input) {
      const v = {
        id: clean(input.id).toUpperCase(),
        name: clean(input.name),
        department: clean(input.department),
        email: clean(input.email).toLowerCase()
      };
      const missing = Object.keys(STUDENT_LABELS).filter((k) => !v[k]).map((k) => STUDENT_LABELS[k]);
      if (missing.length) return fail('Please fill in: ' + missing.join(', ') + '.');
      if (!/^[A-Z0-9][A-Z0-9\-\/_]{1,19}$/.test(v.id)) {
        return fail('Student ID must be 2–20 characters: letters, digits, - / _ only.');
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return fail('Enter a valid email address.');
      return ok(v);
    }

    /* ----- books ----- */
    function addBook(input) {
      const c = cleanBook(input);
      if (!c.ok) return c;
      if (db.books.some((b) => b.isbn === c.data.isbn)) {
        return fail('A book with ISBN ' + c.data.isbn + ' already exists.');
      }
      const book = Object.assign({ id: 'B' + pad(db.seq.book++, 4), addedOn: clock.today() }, c.data);
      db.books.push(book);
      save();
      return ok(book);
    }

    function updateBook(id, input) {
      const book = getBook(id);
      if (!book) return fail('Book not found.');
      const c = cleanBook(input);
      if (!c.ok) return c;
      if (db.books.some((b) => b.isbn === c.data.isbn && b.id !== id)) {
        return fail('Another book already uses ISBN ' + c.data.isbn + '.');
      }
      const out = borrowedCount(id);
      if (c.data.copies < out) {
        return fail('Cannot reduce copies to ' + c.data.copies + ': ' + out + ' ' +
          (out === 1 ? 'copy is' : 'copies are') + ' currently borrowed.');
      }
      Object.assign(book, c.data);
      /* keep the record snapshots in step with corrected details */
      db.loans.forEach((l) => {
        if (l.bookId === id) { l.isbn = book.isbn; l.title = book.title; l.author = book.author; }
      });
      save();
      return ok(book);
    }

    function deleteBook(id) {
      const book = getBook(id);
      if (!book) return fail('Book not found.');
      const out = borrowedCount(id);
      if (out > 0) {
        return fail('Cannot delete "' + book.title + '": ' + plural(out, 'copy is', 'copies are') +
          ' currently issued. Return them first.');
      }
      db.books = db.books.filter((b) => b.id !== id);
      save();
      return ok(book);
    }

    function searchBooks(query) {
      const q = clean(query).toLowerCase();
      const list = db.books.slice().sort((a, b) => a.title.localeCompare(b.title));
      if (!q) return list;
      const qIsbn = normIsbn(q);
      return list.filter((b) =>
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q) ||
        (qIsbn.length >= 4 && b.isbn.includes(qIsbn)));
    }

    /* ----- students ----- */
    function addStudent(input) {
      const c = cleanStudent(input);
      if (!c.ok) return c;
      if (getStudent(c.data.id)) return fail('Student ID ' + c.data.id + ' already exists.');
      db.students.push(c.data);
      save();
      return ok(c.data);
    }

    function updateStudent(id, input) {
      const s = getStudent(id);
      if (!s) return fail('Student not found.');
      const c = cleanStudent(Object.assign({}, input, { id: id })); // ID cannot be changed
      if (!c.ok) return c;
      s.name = c.data.name;
      s.department = c.data.department;
      s.email = c.data.email;
      db.loans.forEach((l) => { if (l.studentId === id) l.studentName = s.name; });
      save();
      return ok(s);
    }

    function deleteStudent(id) {
      const s = getStudent(id);
      if (!s) return fail('Student not found.');
      const held = activeLoansOfStudent(id).length;
      if (held > 0) {
        return fail('Cannot delete ' + s.name + ': ' + plural(held, 'book is', 'books are') + ' still issued to this student.');
      }
      const owed = fineDue(id);
      if (owed > 0) return fail('Cannot delete ' + s.name + ': an unpaid fine of ' + money(owed) + ' is pending.');
      db.students = db.students.filter((x) => x.id !== id);
      save();
      return ok(s);
    }

    function searchStudents(query) {
      const q = clean(query).toLowerCase();
      const list = db.students.slice().sort((a, b) => a.name.localeCompare(b.name));
      if (!q) return list;
      return list.filter((s) =>
        s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.department.toLowerCase().includes(q));
    }

    /* ----- circulation ----- */
    function issueBook(studentId, bookId) {
      const s = getStudent(studentId);
      if (!s) return fail('Select a student.');
      const b = getBook(bookId);
      if (!b) return fail('Select a book.');

      const held = activeLoansOfStudent(s.id);
      if (held.some((l) => l.bookId === b.id)) {
        return fail(s.name + ' already has "' + b.title + '". The same book cannot be borrowed twice.');
      }
      if (held.length >= MAX_BOOKS) {
        return fail(s.name + ' already holds ' + MAX_BOOKS + ' books. A student can hold at most ' + MAX_BOOKS + ' books.');
      }
      const owed = fineDue(s.id);
      if (owed > 0) {
        return fail(s.name + ' has an unpaid fine of ' + money(owed) + '. Pay it before borrowing.');
      }
      const today = clock.today();
      const late = held.find((l) => daysBetween(l.dueDate, today) > 0);
      if (late) {
        return fail(s.name + ' has an overdue book ("' + late.title + '", due ' + fmtDate(late.dueDate) +
          '). Return it before borrowing another.');
      }
      if (availableOf(b) <= 0) {
        return fail('No copies of "' + b.title + '" are available right now.');
      }

      const n = db.seq.loan++;
      const loan = {
        id: 'L' + pad(n, 4), n: n,
        studentId: s.id, studentName: s.name,
        bookId: b.id, isbn: b.isbn, title: b.title, author: b.author,
        issueDate: today, dueDate: addDays(today, LOAN_DAYS),
        returnDate: null, lateDays: 0,
        fine: 0, fineStatus: 'none', paidOn: null, note: ''
      };
      db.loans.push(loan);
      save();
      return ok(loan);
    }

    function returnBook(loanId) {
      const loan = getLoan(loanId);
      if (!loan) return fail('Loan record not found.');
      if (loan.returnDate) return fail('This book has already been returned on ' + fmtDate(loan.returnDate) + '.');

      const today = clock.today();
      if (daysBetween(loan.issueDate, today) < 0) {
        return fail('The return date cannot be earlier than the issue date (' + fmtDate(loan.issueDate) + ').');
      }

      loan.returnDate = today;
      loan.lateDays = Math.max(0, daysBetween(loan.dueDate, today));
      loan.fine = loan.lateDays * FINE_PER_DAY;
      loan.fineStatus = loan.fine > 0 ? 'unpaid' : 'none';
      loan.paidOn = null;
      loan.note = '';
      save();
      return ok(loan);
    }

    function payFine(loanId) {
      const loan = getLoan(loanId);
      if (!loan) return fail('Loan record not found.');
      if (loan.fineStatus === 'paid') return fail('This fine was already paid on ' + fmtDate(loan.paidOn) + '. It cannot be paid twice.');
      if (loan.fineStatus !== 'unpaid') return fail('There is no fine to pay for this loan.');
      loan.fineStatus = 'paid';
      loan.paidOn = clock.today();
      save();
      return ok(loan);
    }

    /* ----- accounts and records ----- */
    function account(studentId) {
      const s = getStudent(studentId);
      if (!s) return null;
      const all = db.loans.filter((l) => l.studentId === studentId).map(describeLoan)
        .sort((a, b) => b.n - a.n);
      return {
        student: s,
        active: all.filter((l) => l.active),
        fines: all.filter((l) => l.fineStatus === 'unpaid'),
        history: all,
        fineDue: fineDue(studentId)
      };
    }

    function records() {
      return db.loans.map(describeLoan).sort((a, b) => b.n - a.n);
    }

    function reset() { db = emptyDb(); save(); }

    return {
      books: () => db.books, students: () => db.students, loans: () => db.loans,
      getBook, getStudent, getLoan, availableOf, borrowedCount, fineDue, describeLoan,
      addBook, updateBook, deleteBook, searchBooks,
      addStudent, updateStudent, deleteStudent, searchStudents,
      issueBook, returnBook, payFine, account, records, reset,
      today: () => clock.today()
    };
  }

  /* ------------------------------------------------------------------
     Part 3: test suite (runs against its own in-memory storage)
     ------------------------------------------------------------------ */
  function memoryStore() {
    const m = {};
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      raw: m
    };
  }

  const T_BOOK1 = { isbn: '9780132350884', title: 'Clean Code', author: 'Robert C. Martin', category: 'Software', copies: 3 };
  const T_BOOK2 = { isbn: '9780201633610', title: 'Design Patterns', author: 'Erich Gamma', category: 'Software', copies: 1 };
  const T_BOOK3 = { isbn: '9780262033848', title: 'Introduction to Algorithms', author: 'Thomas Cormen', category: 'Computer Science', copies: 2 };
  const T_BOOK4 = { isbn: '9780134685991', title: 'Effective Java', author: 'Joshua Bloch', category: 'Software', copies: 2 };
  const T_ST1 = { id: 'CS2023001', name: 'Aarav Mehta', department: 'Computer Science', email: 'aarav@college.edu' };
  const T_ST2 = { id: 'CS2023002', name: 'Isha Kapoor', department: 'Information Technology', email: 'isha@college.edu' };

  function fresh(date) {
    const store = memoryStore();
    const clock = { d: date || '2026-10-03', today() { return clock.d; } };
    return { store: store, clock: clock, lib: createLibrary(store, clock) };
  }

  function must(r) {
    if (!r.ok) throw new Error('Expected success but got error: ' + r.error);
    return r.data;
  }
  function mustFail(r, fragment) {
    if (r.ok) throw new Error('Expected a rejection but the action succeeded');
    if (fragment && !r.error.toLowerCase().includes(fragment.toLowerCase())) {
      throw new Error('Rejected with "' + r.error + '", expected it to mention "' + fragment + '"');
    }
  }
  function eq(actual, expected, label) {
    if (actual !== expected) {
      throw new Error((label || 'Value') + ': expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
    }
  }
  function yes(cond, label) { if (!cond) throw new Error(label || 'Condition was false'); }

  const TESTS = [
    /* ---------------- Books ---------------- */
    ['Books', 'Add book successfully', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      eq(lib.books().length, 1, 'Book count');
      eq(b.title, 'Clean Code', 'Title');
      eq(lib.availableOf(b), 3, 'Available copies');
    }],
    ['Books', 'Reject empty book fields', () => {
      const { lib } = fresh();
      ['isbn', 'title', 'author', 'category', 'copies'].forEach((f) => {
        mustFail(lib.addBook(Object.assign({}, T_BOOK1, { [f]: '   ' })), 'fill in');
      });
      eq(lib.books().length, 0, 'Books saved after rejections');
    }],
    ['Books', 'Reject duplicate ISBN (add and edit)', () => {
      const { lib } = fresh();
      must(lib.addBook(T_BOOK1));
      mustFail(lib.addBook(Object.assign({}, T_BOOK2, { isbn: '978-0-13-235088-4' })), 'already exists');
      const b2 = must(lib.addBook(T_BOOK2));
      mustFail(lib.updateBook(b2.id, Object.assign({}, T_BOOK2, { isbn: T_BOOK1.isbn })), 'already uses');
      eq(lib.books().length, 2, 'Book count');
    }],
    ['Books', 'Edit book details', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.updateBook(b.id, Object.assign({}, T_BOOK1, { title: 'Clean Code (2nd Ed)', copies: 5, category: 'Programming' })));
      const saved = lib.getBook(b.id);
      eq(saved.title, 'Clean Code (2nd Ed)', 'Title');
      eq(saved.copies, 5, 'Copies');
      eq(saved.category, 'Programming', 'Category');
      mustFail(lib.updateBook(b.id, Object.assign({}, T_BOOK1, { author: '' })), 'fill in');
    }],
    ['Books', 'Cannot reduce copies below the number borrowed', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1)); must(lib.addStudent(T_ST2));
      must(lib.issueBook(T_ST1.id, b.id)); must(lib.issueBook(T_ST2.id, b.id));
      mustFail(lib.updateBook(b.id, Object.assign({}, T_BOOK1, { copies: 1 })), 'borrowed');
      must(lib.updateBook(b.id, Object.assign({}, T_BOOK1, { copies: 2 })));
      eq(lib.availableOf(lib.getBook(b.id)), 0, 'Available');
    }],
    ['Books', 'Delete available book', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.deleteBook(b.id));
      eq(lib.books().length, 0, 'Book count');
    }],
    ['Books', 'Deletion of issued book is blocked', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      must(lib.issueBook(T_ST1.id, b.id));
      mustFail(lib.deleteBook(b.id), 'issued');
      eq(lib.books().length, 1, 'Book still present');
    }],
    ['Books', 'Search books by title', () => {
      const { lib } = fresh();
      [T_BOOK1, T_BOOK2, T_BOOK3].forEach((b) => must(lib.addBook(b)));
      eq(lib.searchBooks('clean').length, 1, 'Matches for "clean"');
      eq(lib.searchBooks('clean')[0].title, 'Clean Code', 'Matched title');
      eq(lib.searchBooks('DESIGN pat')[0].title, 'Design Patterns', 'Case-insensitive match');
      eq(lib.searchBooks('').length, 3, 'Empty search shows all');
      eq(lib.searchBooks('zzz-no-such-book').length, 0, 'No match');
    }],
    ['Books', 'Show empty list message', () => {
      const { lib } = fresh();
      const html = tableBody(lib.searchBooks('').map(() => '<tr></tr>'), 7, 'No books found.');
      yes(html.includes('No books found.'), 'Empty message missing');
      yes(html.includes('colspan="7"'), 'Empty row should span the table');
      const withRows = tableBody(['<tr>a</tr>'], 7, 'No books found.');
      yes(!withRows.includes('No books found.'), 'Empty message shown although rows exist');
    }],

    /* ---------------- Students ---------------- */
    ['Students', 'Add student successfully', () => {
      const { lib } = fresh();
      const s = must(lib.addStudent(T_ST1));
      eq(lib.students().length, 1, 'Student count');
      eq(s.id, 'CS2023001', 'ID');
      mustFail(lib.addStudent(Object.assign({}, T_ST2, { name: '' })), 'fill in');
      mustFail(lib.addStudent(Object.assign({}, T_ST2, { email: 'not-an-email' })), 'email');
    }],
    ['Students', 'Reject duplicate student ID', () => {
      const { lib } = fresh();
      must(lib.addStudent(T_ST1));
      mustFail(lib.addStudent(Object.assign({}, T_ST2, { id: 'cs2023001' })), 'already exists');
      eq(lib.students().length, 1, 'Student count');
    }],
    ['Students', 'Edit student details', () => {
      const { lib } = fresh();
      must(lib.addStudent(T_ST1));
      must(lib.updateStudent(T_ST1.id, { id: 'HACKED', name: 'Aarav M. Mehta', department: 'Data Science', email: 'aarav.m@college.edu' }));
      const s = lib.getStudent(T_ST1.id);
      eq(s.name, 'Aarav M. Mehta', 'Name');
      eq(s.department, 'Data Science', 'Department');
      eq(s.email, 'aarav.m@college.edu', 'Email');
      eq(lib.students().length, 1, 'ID must not change');
    }],
    ['Students', 'Cannot delete a student who holds a book', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      must(lib.issueBook(T_ST1.id, b.id));
      mustFail(lib.deleteStudent(T_ST1.id), 'still issued');
      eq(lib.students().length, 1, 'Student still present');
    }],

    /* ---------------- Issue ---------------- */
    ['Issue', 'Issue available book (14-day due date, copy count drops, added to account)', () => {
      const { lib } = fresh('2026-10-03');
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b.id));
      eq(loan.issueDate, '2026-10-03', 'Issue date');
      eq(loan.dueDate, '2026-10-17', 'Due date');
      eq(lib.availableOf(lib.getBook(b.id)), 2, 'Available copies');
      const acc = lib.account(T_ST1.id);
      eq(acc.active.length, 1, 'Books on student account');
      eq(acc.active[0].title, 'Clean Code', 'Book on account');
      eq(acc.history.length, 1, 'History entries');
    }],
    ['Issue', 'Block issue if no copies', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK2));
      must(lib.addStudent(T_ST1)); must(lib.addStudent(T_ST2));
      must(lib.issueBook(T_ST1.id, b.id));
      mustFail(lib.issueBook(T_ST2.id, b.id), 'no copies');
      eq(lib.account(T_ST2.id).active.length, 0, 'Second student books');
    }],
    ['Issue', 'Block issue after 3 books', () => {
      const { lib } = fresh();
      const ids = [T_BOOK1, T_BOOK2, T_BOOK3, T_BOOK4].map((b) => must(lib.addBook(b)).id);
      must(lib.addStudent(T_ST1));
      for (let i = 0; i < 3; i++) must(lib.issueBook(T_ST1.id, ids[i]));
      mustFail(lib.issueBook(T_ST1.id, ids[3]), 'at most 3');
      eq(lib.account(T_ST1.id).active.length, 3, 'Books held');
    }],
    ['Issue', 'Cannot borrow the same book twice', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      must(lib.issueBook(T_ST1.id, b.id));
      mustFail(lib.issueBook(T_ST1.id, b.id), 'already has');
      eq(lib.availableOf(lib.getBook(b.id)), 2, 'Available copies');
    }],
    ['Issue', 'Overdue book blocks borrowing another', () => {
      const { lib, clock } = fresh('2026-10-03');
      const b1 = must(lib.addBook(T_BOOK1)); const b3 = must(lib.addBook(T_BOOK3));
      must(lib.addStudent(T_ST1));
      must(lib.issueBook(T_ST1.id, b1.id));
      clock.d = '2026-10-17';                      // due today: still fine
      must(lib.issueBook(T_ST1.id, b3.id));
      eq(lib.account(T_ST1.id).active.length, 2, 'Books held on due date');
      const b4 = must(lib.addBook(T_BOOK4));
      clock.d = '2026-10-18';                      // one day overdue
      mustFail(lib.issueBook(T_ST1.id, b4.id), 'overdue');
    }],

    /* ---------------- Return and fines ---------------- */
    ['Return', 'Return issued book on time (no fine, copy freed)', () => {
      const { lib, clock } = fresh('2026-10-03');
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b.id));
      clock.d = '2026-10-17';                      // exactly on the due date
      const r = must(lib.returnBook(loan.id));
      eq(r.returnDate, '2026-10-17', 'Return date');
      eq(r.fine, 0, 'Fine');
      eq(r.fineStatus, 'none', 'Fine status');
      eq(lib.availableOf(lib.getBook(b.id)), 3, 'Available copies');
      eq(lib.account(T_ST1.id).active.length, 0, 'Books still held');
    }],
    ['Return', 'Block double return', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b.id));
      must(lib.returnBook(loan.id));
      mustFail(lib.returnBook(loan.id), 'already been returned');
      eq(lib.availableOf(lib.getBook(b.id)), 3, 'Copies must not exceed total');
    }],
    ['Return', 'Calculate overdue fine (₹2 per day)', () => {
      const { lib, clock } = fresh('2026-10-03');
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b.id));
      clock.d = '2026-10-22';                      // due 17 Oct, 5 days late
      const r = must(lib.returnBook(loan.id));
      eq(r.lateDays, 5, 'Late days');
      eq(r.fine, 10, 'Fine');
      eq(r.fineStatus, 'unpaid', 'Fine status');
      eq(lib.fineDue(T_ST1.id), 10, 'Fine due');
    }],
    ['Return', 'Unpaid fine blocks borrowing until paid', () => {
      const { lib, clock } = fresh('2026-10-03');
      const b1 = must(lib.addBook(T_BOOK1)); const b3 = must(lib.addBook(T_BOOK3));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b1.id));
      clock.d = '2026-10-20';
      must(lib.returnBook(loan.id));
      mustFail(lib.issueBook(T_ST1.id, b3.id), 'unpaid fine');
      mustFail(lib.deleteStudent(T_ST1.id), 'unpaid fine');
      must(lib.payFine(loan.id));
      must(lib.issueBook(T_ST1.id, b3.id));
    }],
    ['Return', 'Pay fine successfully', () => {
      const { lib, clock } = fresh('2026-10-03');
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b.id));
      clock.d = '2026-10-22';
      must(lib.returnBook(loan.id));
      const paid = must(lib.payFine(loan.id));
      eq(paid.fineStatus, 'paid', 'Fine status');
      eq(paid.paidOn, '2026-10-22', 'Paid on');
      eq(lib.fineDue(T_ST1.id), 0, 'Fine due');
      mustFail(lib.payFine('L9999'), 'not found');
    }],
    ['Return', 'Charge the normal fine on every late return', () => {
      const { lib, clock } = fresh('2026-10-03');
      const b1 = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));

      const first = must(lib.issueBook(T_ST1.id, b1.id));
      clock.d = '2026-10-22';
      eq(must(lib.returnBook(first.id)).fine, 10, 'First late fine');
      must(lib.payFine(first.id));
      mustFail(lib.payFine(first.id), 'already paid');

      const second = must(lib.issueBook(T_ST1.id, b1.id));
      clock.d = '2026-11-12';
      const r2 = must(lib.returnBook(second.id));
      eq(r2.fine, 14, 'Second late fine');
      eq(r2.fineStatus, 'unpaid', 'Second fine status');
      eq(lib.fineDue(T_ST1.id), 14, 'Fine due');

      must(lib.payFine(second.id));
      eq(lib.fineDue(T_ST1.id), 0, 'Fine cleared');
    }],

    /* ---------------- Storage ---------------- */
    ['Storage', 'Save data in localStorage', () => {
      const { lib, store } = fresh();
      yes(store.getItem(STORAGE_KEY) === null, 'Nothing should be stored before any change');
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      must(lib.issueBook(T_ST1.id, b.id));
      const saved = JSON.parse(store.getItem(STORAGE_KEY));
      eq(saved.books.length, 1, 'Saved books');
      eq(saved.students.length, 1, 'Saved students');
      eq(saved.loans.length, 1, 'Saved loans');
    }],
    ['Storage', 'Data is still there after a refresh', () => {
      const { lib, store, clock } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      must(lib.issueBook(T_ST1.id, b.id));
      const reloaded = createLibrary(store, clock);          // simulates a page refresh
      eq(reloaded.books().length, 1, 'Books');
      eq(reloaded.students().length, 1, 'Students');
      eq(reloaded.account(T_ST1.id).active.length, 1, 'Active loans');
      eq(reloaded.availableOf(reloaded.getBook(b.id)), 2, 'Available copies');
      const next = must(reloaded.addBook(T_BOOK2));
      yes(next.id !== b.id, 'New book must get a fresh ID');
    }],
    ['Storage', 'Corrupt saved data does not crash the app', () => {
      const store = memoryStore();
      store.setItem(STORAGE_KEY, '{not valid json');
      const lib = createLibrary(store);
      eq(lib.books().length, 0, 'Books');
      must(lib.addBook(T_BOOK1));
    }],

    /* ---------------- Records ---------------- */
    ['Records', 'Records stay readable after the book is deleted', () => {
      const { lib } = fresh();
      const b = must(lib.addBook(T_BOOK1));
      must(lib.addStudent(T_ST1));
      const loan = must(lib.issueBook(T_ST1.id, b.id));
      must(lib.returnBook(loan.id));
      must(lib.deleteBook(b.id));
      const rec = lib.records();
      eq(rec.length, 1, 'Records');
      eq(rec[0].title, 'Clean Code', 'Title kept in record');
      eq(rec[0].author, 'Robert C. Martin', 'Author kept in record');
      eq(rec[0].bookRemoved, true, 'Removed flag');
      eq(lib.account(T_ST1.id).history[0].title, 'Clean Code', 'Student history');
    }]
  ];

  function runTests() {
    return TESTS.map((t) => {
      try { t[2](); return { group: t[0], name: t[1], pass: true }; }
      catch (e) { return { group: t[0], name: t[1], pass: false, error: e.message }; }
    });
  }

  /* ------------------------------------------------------------------
     Part 4: user interface
     ------------------------------------------------------------------ */
  function initUI() {
    const $ = (sel) => document.querySelector(sel);

    /* storage: fall back to memory if the browser blocks localStorage */
    let storage;
    let persistent = true;
    try {
      storage = window.localStorage;
      storage.setItem('lms.probe', '1');
      storage.removeItem('lms.probe');
    } catch (e) {
      storage = memoryStore();
      persistent = false;
    }

    const clock = {
      override: null,
      today() { return this.override || localISO(new Date()); }
    };
    const lib = createLibrary(storage, clock);

    let openAccountId = null;
    let testsRun = false;

    /* ----- feedback ----- */
    let toastTimer = null;
    function toast(msg, type) {
      const t = $('#toast');
      t.textContent = msg;
      t.className = 'toast ' + (type || 'ok');
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 6000 : 3200);
    }
    function formError(el, msg) {
      el.textContent = msg || '';
      el.hidden = !msg;
    }
    function report(r, successMsg) {
      if (r.ok) { toast(successMsg, 'ok'); renderAll(); }
      else toast(r.error, 'error');
      return r;
    }

    /* ----- small html pieces ----- */
    const btn = (action, attrs, label, cls) =>
      '<button type="button" class="row-btn ' + (cls || '') + '" data-action="' + action + '" ' + attrs + '>' + label + '</button>';

    function fineLabel(l) {
      if (l.fineStatus === 'unpaid') return '<span class="badge danger">Unpaid</span>';
      if (l.fineStatus === 'paid') return '<span class="badge ok">Paid ' + esc(fmtDate(l.paidOn)) + '</span>';
      if (l.fineStatus === 'waived') return '<span class="badge neutral" title="' + esc(l.note) + '">Waived</span>';
      return '<span class="muted">—</span>';
    }
    function loanStatus(d) {
      if (!d.active) return '<span class="badge neutral">Returned</span>';
      if (d.overdue) return '<span class="text-danger">Overdue by ' + plural(d.overdueDays, 'day', 'days') + '</span>';
      if (d.daysLeft === 0) return '<span class="badge warn">Due today</span>';
      return 'Due in ' + plural(d.daysLeft, 'day', 'days');
    }
    const bookCell = (d) =>
      esc(d.title) + (d.bookRemoved ? ' <span class="badge neutral">Book removed</span>' : '') +
      '<span class="sub">' + esc(d.isbn) + '</span>';
    const studentCell = (d) => esc(d.studentName) + '<span class="sub">' + esc(d.studentId) + '</span>';
    const fineAmount = (d) => (d.fine > 0 ? money(d.fine) : '—');

    /* ----- Books ----- */
    function renderBooks() {
      const rows = lib.searchBooks($('#bookSearch').value).map((b) => {
        const avail = lib.availableOf(b);
        return '<tr>' +
          '<td>' + esc(b.isbn) + '</td>' +
          '<td>' + esc(b.title) + '</td>' +
          '<td>' + esc(b.author) + '</td>' +
          '<td>' + esc(b.category) + '</td>' +
          '<td class="num">' + b.copies + '</td>' +
          '<td class="num">' + (avail > 0 ? avail : '<span class="badge danger">0</span>') + '</td>' +
          '<td class="actions">' + btn('edit-book', 'data-id="' + esc(b.id) + '"', 'Edit') +
          btn('delete-book', 'data-id="' + esc(b.id) + '"', 'Delete', 'danger') + '</td></tr>';
      });
      const searching = $('#bookSearch').value.trim() !== '';
      $('#bookRows').innerHTML = tableBody(rows, 7,
        searching ? 'No books match your search.' : 'No books yet. Click "Add book" to create the first one.');

      const books = lib.books();
      const copies = books.reduce((n, b) => n + b.copies, 0);
      const out = books.reduce((n, b) => n + lib.borrowedCount(b.id), 0);
      $('#bookSummary').textContent = plural(books.length, 'title', 'titles') + ' · ' +
        plural(copies, 'copy', 'copies') + ' · ' + out + ' issued';

      const cats = Array.from(new Set(books.map((b) => b.category))).sort();
      $('#categoryList').innerHTML = cats.map((c) => '<option value="' + esc(c) + '"></option>').join('');
    }

    /* ----- Students ----- */
    function renderStudents() {
      const rows = lib.searchStudents($('#studentSearch').value).map((s) => {
        const held = lib.account(s.id).active.length;
        const owed = lib.fineDue(s.id);
        return '<tr>' +
          '<td>' + esc(s.id) + '</td>' +
          '<td>' + esc(s.name) + '</td>' +
          '<td>' + esc(s.department) + '</td>' +
          '<td>' + esc(s.email) + '</td>' +
          '<td class="num">' + held + ' / ' + MAX_BOOKS + '</td>' +
          '<td class="num">' + (owed ? '<span class="text-danger">' + money(owed) + '</span>' : '—') + '</td>' +
          '<td class="actions">' + btn('account', 'data-id="' + esc(s.id) + '"', 'Account') +
          btn('edit-student', 'data-id="' + esc(s.id) + '"', 'Edit') +
          btn('delete-student', 'data-id="' + esc(s.id) + '"', 'Delete', 'danger') + '</td></tr>';
      });
      const searching = $('#studentSearch').value.trim() !== '';
      $('#studentRows').innerHTML = tableBody(rows, 7,
        searching ? 'No students match your search.' : 'No students yet. Click "Add student" to register one.');
      $('#studentSummary').textContent = plural(lib.students().length, 'student', 'students') + ' registered';
    }

    /* ----- Circulation ----- */
    function renderCirculation() {
      const sSel = $('#issueStudent');
      const bSel = $('#issueBook');
      const prevS = sSel.value;
      const prevB = bSel.value;

      sSel.innerHTML = '<option value="">Select student…</option>' +
        lib.students().slice().sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + ' (' + esc(s.id) + ')</option>').join('');
      bSel.innerHTML = '<option value="">Select book…</option>' +
        lib.books().slice().sort((a, b) => a.title.localeCompare(b.title))
          .map((b) => {
            const a = lib.availableOf(b);
            return '<option value="' + esc(b.id) + '">' + esc(b.title) + ' — ' +
              (a > 0 ? a + ' available' : 'none available') + '</option>';
          }).join('');
      if (lib.getStudent(prevS)) sSel.value = prevS;
      if (lib.getBook(prevB)) bSel.value = prevB;

      const today = lib.today();
      $('#issueDates').textContent = 'Issue ' + fmtDate(today) + '  →  Due ' + fmtDate(addDays(today, LOAN_DAYS));

      const active = lib.records().filter((d) => d.active).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      $('#activeRows').innerHTML = tableBody(active.map((d) =>
        '<tr><td>' + esc(d.id) + '</td><td>' + studentCell(d) + '</td><td>' + bookCell(d) + '</td>' +
        '<td>' + esc(fmtDate(d.issueDate)) + '</td><td>' + esc(fmtDate(d.dueDate)) + '</td>' +
        '<td>' + loanStatus(d) + '</td>' +
        '<td class="num">' + (d.accrued ? money(d.accrued) : '—') + '</td>' +
        '<td class="actions">' + btn('return', 'data-id="' + esc(d.id) + '"', 'Return') + '</td></tr>'
      ), 8, 'No books are currently issued.');

      const fines = lib.records().filter((d) => d.fineStatus === 'unpaid');
      $('#fineRows').innerHTML = tableBody(fines.map((d) =>
        '<tr><td>' + esc(d.id) + '</td><td>' + studentCell(d) + '</td><td>' + bookCell(d) + '</td>' +
        '<td>' + esc(fmtDate(d.returnDate)) + '</td><td class="num">' + d.lateDays + '</td>' +
        '<td class="num">' + money(d.fine) + '</td>' +
        '<td class="actions">' + btn('pay', 'data-id="' + esc(d.id) + '"', 'Mark paid', 'pay') + '</td></tr>'
      ), 7, 'No unpaid fines.');
    }

    /* ----- Records ----- */
    function renderRecords() {
      const q = $('#recordSearch').value.trim().toLowerCase();
      const f = $('#recordFilter').value;
      const rows = lib.records().filter((d) => {
        if (q && !(d.title + ' ' + d.studentName + ' ' + d.studentId + ' ' + d.isbn).toLowerCase().includes(q)) return false;
        if (f === 'active') return d.active;
        if (f === 'overdue') return d.overdue;
        if (f === 'returned') return !d.active;
        if (f === 'unpaid') return d.fineStatus === 'unpaid';
        if (f === 'paid') return d.fineStatus === 'paid';
        return true;
      }).map((d) =>
        '<tr><td>' + esc(d.id) + '</td><td>' + studentCell(d) + '</td><td>' + bookCell(d) + '</td>' +
        '<td>' + esc(fmtDate(d.issueDate)) + '</td><td>' + esc(fmtDate(d.dueDate)) + '</td>' +
        '<td>' + (d.active ? loanStatus(d) : esc(fmtDate(d.returnDate))) + '</td>' +
        '<td class="num">' + (d.active ? (d.accrued ? money(d.accrued) + ' <span class="sub">accruing</span>' : '—') : fineAmount(d)) + '</td>' +
        '<td>' + fineLabel(d) + (d.note ? '<span class="sub">' + esc(d.note) + '</span>' : '') + '</td></tr>');
      $('#recordRows').innerHTML = tableBody(rows, 8,
        lib.loans().length ? 'No records match this filter.' : 'No borrowing records yet.');
    }

    /* ----- Student account dialog ----- */
    function renderAccount() {
      const dlg = $('#accountDialog');
      if (!openAccountId || !dlg.open) return;
      const acc = lib.account(openAccountId);
      if (!acc) { dlg.close(); return; }
      $('#accTitle').textContent = acc.student.name;

      const activeRows = acc.active.map((d) =>
        '<tr><td>' + bookCell(d) + '</td><td>' + esc(fmtDate(d.issueDate)) + '</td><td>' + esc(fmtDate(d.dueDate)) + '</td>' +
        '<td>' + loanStatus(d) + '</td><td class="num">' + (d.accrued ? money(d.accrued) : '—') + '</td>' +
        '<td class="actions">' + btn('return', 'data-id="' + esc(d.id) + '"', 'Return') + '</td></tr>');
      const fineRows = acc.fines.map((d) =>
        '<tr><td>' + bookCell(d) + '</td><td>' + esc(fmtDate(d.returnDate)) + '</td><td class="num">' + d.lateDays + '</td>' +
        '<td class="num">' + money(d.fine) + '</td>' +
        '<td class="actions">' + btn('pay', 'data-id="' + esc(d.id) + '"', 'Mark paid', 'pay') + '</td></tr>');
      const histRows = acc.history.map((d) =>
        '<tr><td>' + esc(d.id) + '</td><td>' + bookCell(d) + '</td><td>' + esc(fmtDate(d.issueDate)) + '</td>' +
        '<td>' + (d.active ? loanStatus(d) : esc(fmtDate(d.returnDate))) + '</td>' +
        '<td class="num">' + (d.active ? '—' : fineAmount(d)) + '</td><td>' + fineLabel(d) + '</td></tr>');

      $('#accBody').innerHTML =
        '<div class="acc-meta">' +
        '<div><strong>Student ID</strong>' + esc(acc.student.id) + '</div>' +
        '<div><strong>Department</strong>' + esc(acc.student.department) + '</div>' +
        '<div><strong>Email</strong>' + esc(acc.student.email) + '</div>' +
        '<div><strong>Books held</strong>' + acc.active.length + ' / ' + MAX_BOOKS + '</div>' +
        '<div><strong>Fine due</strong>' + (acc.fineDue ? '<span class="text-danger">' + money(acc.fineDue) + '</span>' : '—') + '</div>' +
        '</div>' +
        '<h3>Currently borrowed</h3><div class="table-wrap"><table><thead><tr><th>Book</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Fine so far</th><th class="actions-col">Action</th></tr></thead><tbody>' +
        tableBody(activeRows, 6, 'No books borrowed right now.') + '</tbody></table></div>' +
        '<h3>Fines to pay</h3><div class="table-wrap"><table><thead><tr><th>Book</th><th>Returned</th><th class="num">Days late</th><th class="num">Fine</th><th class="actions-col">Action</th></tr></thead><tbody>' +
        tableBody(fineRows, 5, 'No unpaid fines.') + '</tbody></table></div>' +
        '<h3>Borrowing history</h3><div class="table-wrap"><table><thead><tr><th>Loan</th><th>Book</th><th>Issued</th><th>Returned / status</th><th class="num">Fine</th><th>Fine status</th></tr></thead><tbody>' +
        tableBody(histRows, 6, 'This student has not borrowed anything yet.') + '</tbody></table></div>';
    }

    /* ----- Tests ----- */
    function renderTests() {
      const results = runTests();
      const passed = results.filter((r) => r.pass).length;
      const sum = $('#testSummary');
      sum.textContent = passed + ' of ' + results.length + ' tests passed' + (passed === results.length ? '.' : ' — see failures below.');
      sum.className = 'test-summary ' + (passed === results.length ? 'pass' : 'fail');

      let html = '';
      let group = null;
      results.forEach((r) => {
        if (r.group !== group) { group = r.group; html += '<li class="group">' + esc(group) + '</li>'; }
        html += '<li><span class="badge ' + (r.pass ? 'ok' : 'danger') + '">' + (r.pass ? 'Pass' : 'Fail') + '</span>' +
          '<span>' + esc(r.name) + (r.pass ? '' : '<span class="err">' + esc(r.error) + '</span>') + '</span></li>';
      });
      $('#testList').innerHTML = html;
      testsRun = true;
    }

    function renderAll() {
      renderBooks();
      renderStudents();
      renderCirculation();
      renderRecords();
      renderAccount();
      const sim = clock.override !== null;
      $('#sysDate').value = lib.today();
      $('#simFlag').hidden = !sim;
    }

    /* ----- tabs ----- */
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
        document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + tab.dataset.tab; });
        if (tab.dataset.tab === 'tests' && !testsRun) renderTests();
      });
    });

    /* ----- date control (lets you try overdue fines) ----- */
    $('#sysDate').addEventListener('change', (e) => {
      const v = e.target.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) clock.override = v === localISO(new Date()) ? null : v;
      renderAll();
    });
    $('#btnResetDate').addEventListener('click', () => { clock.override = null; renderAll(); });

    /* ----- search boxes ----- */
    $('#bookSearch').addEventListener('input', renderBooks);
    $('#studentSearch').addEventListener('input', renderStudents);
    $('#recordSearch').addEventListener('input', renderRecords);
    $('#recordFilter').addEventListener('change', renderRecords);

    /* ----- dialogs: close buttons ----- */
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        const dlg = e.target.closest('dialog');
        if (dlg) dlg.close();
      }
    });
    $('#accountDialog').addEventListener('close', () => { openAccountId = null; });

    /* ----- book form ----- */
    function openBookDialog(book) {
      $('#bookDialogTitle').textContent = book ? 'Edit book' : 'Add book';
      $('#bk-id').value = book ? book.id : '';
      $('#bk-isbn').value = book ? book.isbn : '';
      $('#bk-title').value = book ? book.title : '';
      $('#bk-author').value = book ? book.author : '';
      $('#bk-category').value = book ? book.category : '';
      $('#bk-copies').value = book ? book.copies : 1;
      formError($('#bookError'), '');
      $('#bookDialog').showModal();
      $('#bk-isbn').focus();
    }
    $('#btnAddBook').addEventListener('click', () => openBookDialog(null));
    $('#bookForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('#bk-id').value;
      const data = {
        isbn: $('#bk-isbn').value, title: $('#bk-title').value, author: $('#bk-author').value,
        category: $('#bk-category').value, copies: $('#bk-copies').value
      };
      const r = id ? lib.updateBook(id, data) : lib.addBook(data);
      if (!r.ok) { formError($('#bookError'), r.error); return; }
      $('#bookDialog').close();
      toast(id ? 'Book details updated.' : '"' + r.data.title + '" added to the library.', 'ok');
      renderAll();
    });

    /* ----- student form ----- */
    function openStudentDialog(student) {
      $('#studentDialogTitle').textContent = student ? 'Edit student' : 'Add student';
      $('#st-mode').value = student ? student.id : '';
      $('#st-id').value = student ? student.id : '';
      $('#st-id').readOnly = !!student;
      $('#st-name').value = student ? student.name : '';
      $('#st-dept').value = student ? student.department : '';
      $('#st-email').value = student ? student.email : '';
      formError($('#studentError'), '');
      $('#studentDialog').showModal();
      (student ? $('#st-name') : $('#st-id')).focus();
    }
    $('#btnAddStudent').addEventListener('click', () => openStudentDialog(null));
    $('#studentForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const editing = $('#st-mode').value;
      const data = {
        id: $('#st-id').value, name: $('#st-name').value,
        department: $('#st-dept').value, email: $('#st-email').value
      };
      const r = editing ? lib.updateStudent(editing, data) : lib.addStudent(data);
      if (!r.ok) { formError($('#studentError'), r.error); return; }
      $('#studentDialog').close();
      toast(editing ? 'Student details updated.' : r.data.name + ' registered.', 'ok');
      renderAll();
    });

    /* ----- issue form ----- */
    $('#issueForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const r = lib.issueBook($('#issueStudent').value, $('#issueBook').value);
      if (r.ok) {
        toast('"' + r.data.title + '" issued to ' + r.data.studentName + '. Due ' + fmtDate(r.data.dueDate) + '.', 'ok');
        $('#issueBook').value = '';
        renderAll();
      } else {
        toast(r.error, 'error');
      }
    });

    /* ----- row actions (books, students, loans) ----- */
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const id = el.dataset.id;

      switch (el.dataset.action) {
        case 'edit-book': openBookDialog(lib.getBook(id)); break;
        case 'delete-book': {
          const b = lib.getBook(id);
          if (b && confirm('Delete "' + b.title + '"? Past borrowing records will be kept.')) {
            report(lib.deleteBook(id), '"' + b.title + '" deleted.');
          }
          break;
        }
        case 'edit-student': openStudentDialog(lib.getStudent(id)); break;
        case 'delete-student': {
          const s = lib.getStudent(id);
          if (s && confirm('Delete student ' + s.name + '? Past borrowing records will be kept.')) {
            report(lib.deleteStudent(id), s.name + ' removed.');
          }
          break;
        }
        case 'account':
          openAccountId = id;
          $('#accountDialog').showModal();
          renderAccount();
          break;
        case 'return': {
          const r = lib.returnBook(id);
          if (r.ok) {
            const msg = r.data.fine > 0
              ? 'Returned ' + r.data.lateDays + ' day(s) late. Fine ' + money(r.data.fine) + ' is due.'
              : 'Book returned on time. No fine.';
            toast(msg, 'ok'); renderAll();
          } else toast(r.error, 'error');
          break;
        }
        case 'pay': {
          const l = lib.getLoan(id);
          if (l && confirm('Collect ' + money(l.fine) + ' from ' + l.studentName + ' for "' + l.title + '"?')) {
            report(lib.payFine(id), 'Fine of ' + money(l.fine) + ' paid.');
          }
          break;
        }
      }
    });

    /* ----- tests + data tools ----- */
    $('#btnRunTests').addEventListener('click', renderTests);

    $('#btnSample').addEventListener('click', () => {
      const books = [
        ['9780132350884', 'Clean Code', 'Robert C. Martin', 'Software', 3],
        ['9780201633610', 'Design Patterns', 'Erich Gamma', 'Software', 1],
        ['9780262033848', 'Introduction to Algorithms', 'Thomas Cormen', 'Computer Science', 2],
        ['9780134685991', 'Effective Java', 'Joshua Bloch', 'Software', 2],
        ['9780073523323', 'Database System Concepts', 'Abraham Silberschatz', 'Databases', 2],
        ['9780132126953', 'Computer Networks', 'Andrew Tanenbaum', 'Networking', 1]
      ];
      const students = [
        ['CS2023001', 'Aarav Mehta', 'Computer Science', 'aarav@college.edu'],
        ['CS2023002', 'Isha Kapoor', 'Information Technology', 'isha@college.edu'],
        ['EC2022014', 'Rohan Iyer', 'Electronics', 'rohan@college.edu']
      ];
      let added = 0;
      books.forEach((b) => { if (lib.addBook({ isbn: b[0], title: b[1], author: b[2], category: b[3], copies: b[4] }).ok) added++; });
      students.forEach((s) => { if (lib.addStudent({ id: s[0], name: s[1], department: s[2], email: s[3] }).ok) added++; });
      toast(added ? 'Sample data added.' : 'Sample data is already loaded.', added ? 'ok' : 'error');
      renderAll();
    });

    $('#btnClear').addEventListener('click', () => {
      if (confirm('Delete ALL books, students and records from this browser? This cannot be undone.')) {
        lib.reset();
        toast('All data cleared.', 'ok');
        renderAll();
      }
    });

    renderAll();
    if (!persistent) toast('Browser storage is unavailable, so data will be lost on refresh.', 'error');
  }

  /* ------------------------------------------------------------------
     Start-up
     ------------------------------------------------------------------ */
  if (typeof document !== 'undefined') initUI();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createLibrary: createLibrary, runTests: runTests, tableBody: tableBody };
  }
})();
