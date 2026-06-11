(() => {
  const socket = io();

  // ---- Elements -------------------------------------------------------
  const phases = {
    lobby: document.getElementById('lobbyPhase'),
    writing: document.getElementById('writingPhase'),
    reveal: document.getElementById('revealPhase'),
    voting: document.getElementById('votingPhase'),
    results: document.getElementById('resultsPhase')
  };

  const qrImg = document.getElementById('qrImg');
  const roomCodeText = document.getElementById('roomCodeText');
  const joinUrlText = document.getElementById('joinUrlText');
  const lobbyPlayerList = document.getElementById('lobbyPlayerList');
  const seedInput = document.getElementById('seedInput');
  const startBtn = document.getElementById('startBtn');

  const pausedMsg = document.getElementById('pausedMsg');
  const writingActive = document.getElementById('writingActive');
  const turnBanner = document.getElementById('turnBanner');
  const timerText = document.getElementById('timerText');
  const storyDisplay = document.getElementById('storyDisplay');
  const pendingArea = document.getElementById('pendingArea');
  const pendingAuthor = document.getElementById('pendingAuthor');
  const pendingText = document.getElementById('pendingText');
  const approveBtn = document.getElementById('approveBtn');
  const skipBtn = document.getElementById('skipBtn');
  const endStoryBtn = document.getElementById('endStoryBtn');

  const revealStory = document.getElementById('revealStory');
  const startVotingBtn = document.getElementById('startVotingBtn');

  const votingStory = document.getElementById('votingStory');
  const voteProgressText = document.getElementById('voteProgressText');
  const endVotingBtn = document.getElementById('endVotingBtn');

  const winnersTitle = document.getElementById('winnersTitle');
  const winnersContainer = document.getElementById('winnersContainer');
  const resultsStory = document.getElementById('resultsStory');
  const tallyList = document.getElementById('tallyList');
  const newStoryBtn = document.getElementById('newStoryBtn');
  const endSessionBtn = document.getElementById('endSessionBtn');

  const errorToast = document.getElementById('errorToast');

  // ---- State tracking ---------------------------------------------------
  let lastPhase = null;
  let revealAnimated = false;

  // ---- SFX (Web Audio - simple tones, no voice/TTS) ----------------------
  let audioCtx = null;
  let sfxEnabled = true;
  function playTone(freq, duration, type = 'sine', delay = 0) {
    if (!sfxEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const t = audioCtx.currentTime + delay;
      osc.start(t);
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.stop(t + duration);
    } catch (e) {
      // ignore audio errors (autoplay restrictions, etc.)
    }
  }
  const sfx = {
    pageTurn: (delay = 0) => playTone(440, 0.18, 'triangle', delay),
    approve: () => playTone(660, 0.15, 'sine'),
    fanfare: () => {
      playTone(523, 0.2, 'square', 0);
      playTone(659, 0.2, 'square', 0.15);
      playTone(784, 0.35, 'square', 0.3);
    }
  };

  // ---- Helpers ------------------------------------------------------------
  function showPhase(phase) {
    for (const key of Object.keys(phases)) {
      phases[key].classList.toggle('hidden', key !== phase);
    }
  }

  function showError(text) {
    errorToast.textContent = text;
    errorToast.classList.add('show');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => errorToast.classList.remove('show'), 3000);
  }

  function renderStoryLines(container, story) {
    container.innerHTML = '';
    for (const line of story) {
      const div = document.createElement('div');
      div.className = 'story-line';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = line.lineNo;
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.text;
      div.appendChild(num);
      div.appendChild(text);
      if (line.authorName) {
        const author = document.createElement('span');
        author.className = 'author';
        author.textContent = `— ${line.authorName}`;
        div.appendChild(author);
      }
      container.appendChild(div);
    }
  }

  function renderPlayerList(ul, players, currentTurnPlayerId) {
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'player-chip';
      if (!p.connected) li.classList.add('disconnected');
      if (p.id === currentTurnPlayerId) li.classList.add('current');
      const span = document.createElement('span');
      span.textContent = p.name;
      li.appendChild(span);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'إزالة اللاعب';
      removeBtn.addEventListener('click', () => {
        socket.emit('host:removePlayer', { playerId: p.id });
      });
      li.appendChild(removeBtn);

      ul.appendChild(li);
    }
  }

  function renderWinners(state) {
    winnersContainer.innerHTML = '';
    const winners = state.results ? state.results.winners : [];
    if (winners.length === 0) {
      winnersTitle.textContent = 'لم يصوّت أحد!';
      return;
    }
    winnersTitle.textContent = winners.length > 1 ? '🎉 تعادل بين الفائزين! 🎉' : '🎉 الفائز بأطرف جملة 🎉';
    for (const lineNo of winners) {
      const line = state.story.find(l => l.lineNo === lineNo);
      if (!line) continue;
      const wrap = document.createElement('div');
      wrap.className = 'winner-line';
      wrap.textContent = `"${line.text}"`;
      const author = document.createElement('div');
      author.className = 'winner-author';
      author.textContent = line.authorName ? `بقلم: ${line.authorName}` : '';
      winnersContainer.appendChild(wrap);
      winnersContainer.appendChild(author);
    }
  }

  function renderTally(state) {
    tallyList.innerHTML = '';
    if (!state.results) return;
    const winners = new Set(state.results.winners);
    for (const line of state.story) {
      if (line.lineNo === 0) continue;
      const row = document.createElement('div');
      row.className = 'tally-row';
      if (winners.has(line.lineNo)) row.classList.add('winner');
      const left = document.createElement('span');
      left.textContent = `${line.lineNo}. ${line.text}`;
      const right = document.createElement('span');
      const count = state.results.tallies[line.lineNo] || 0;
      right.textContent = `${count} صوت`;
      row.appendChild(left);
      row.appendChild(right);
      tallyList.appendChild(row);
    }
  }

  function runRevealAnimation(story) {
    revealStory.innerHTML = '';
    startVotingBtn.classList.add('hidden');
    const PACE_MS = 1200;
    story.forEach((line, i) => {
      const div = document.createElement('div');
      div.className = 'story-line reveal-anim';
      div.style.animationDelay = `${i * PACE_MS}ms`;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = line.lineNo;
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = line.text;
      div.appendChild(num);
      div.appendChild(text);
      revealStory.appendChild(div);
      sfx.pageTurn((i * PACE_MS) / 1000);
    });
    const totalMs = story.length * PACE_MS + 600;
    setTimeout(() => {
      startVotingBtn.classList.remove('hidden');
    }, totalMs);
  }

  // ---- Main render ---------------------------------------------------------
  function render(state) {
    sfxEnabled = !!state.config.sfxEnabled;

    if (state.qrDataUrl) qrImg.src = state.qrDataUrl;
    roomCodeText.textContent = state.roomCode;
    joinUrlText.textContent = state.joinUrl || '';

    showPhase(state.phase);

    if (state.phase === 'lobby') {
      renderPlayerList(lobbyPlayerList, state.players, null);
      startBtn.disabled = state.players.length === 0;
    }

    if (state.phase === 'writing') {
      pausedMsg.classList.toggle('hidden', !state.paused);
      writingActive.classList.toggle('hidden', state.paused);

      if (!state.paused) {
        const current = state.players.find(p => p.id === state.currentTurnPlayerId);
        turnBanner.textContent = current ? `دور ${current.name} الآن…` : '';
        timerText.textContent = state.secondsLeft;
        timerText.classList.toggle('low', state.secondsLeft <= 5);
      }

      renderStoryLines(storyDisplay, state.story);

      if (state.pending) {
        pendingArea.classList.remove('hidden');
        pendingAuthor.textContent = `${state.pending.authorName} يقترح:`;
        pendingText.textContent = `"${state.pending.text}"`;
      } else {
        pendingArea.classList.add('hidden');
      }
    }

    if (state.phase === 'reveal') {
      if (lastPhase !== 'reveal') {
        revealAnimated = false;
      }
      if (!revealAnimated) {
        revealAnimated = true;
        runRevealAnimation(state.story);
      }
    }

    if (state.phase === 'voting') {
      renderStoryLines(votingStory, state.story.filter(l => l.lineNo > 0));
      if (state.voteProgress) {
        voteProgressText.textContent = `صوّت ${state.voteProgress.voted} من ${state.voteProgress.total}`;
      }
    }

    if (state.phase === 'results') {
      renderWinners(state);
      renderStoryLines(resultsStory, state.story);
      renderTally(state);
      if (lastPhase !== 'results') {
        sfx.fanfare();
      }
    }

    lastPhase = state.phase;
  }

  // ---- Socket events --------------------------------------------------------
  socket.on('connect', () => {
    const savedRoomCode = sessionStorage.getItem('qj_hostRoomCode');
    if (savedRoomCode) {
      socket.emit('host:reconnect', { roomCode: savedRoomCode });
    } else {
      socket.emit('host:create', {}, (res) => {
        sessionStorage.setItem('qj_hostRoomCode', res.roomCode);
      });
    }
  });

  socket.on('state', (state) => {
    if (state.roomCode) sessionStorage.setItem('qj_hostRoomCode', state.roomCode);
    render(state);
  });

  socket.on('turn:tick', ({ secondsLeft }) => {
    if (!phases.writing.classList.contains('hidden')) {
      timerText.textContent = secondsLeft;
      timerText.classList.toggle('low', secondsLeft <= 5);
    }
  });

  socket.on('error:msg', ({ text }) => showError(text));

  // ---- UI events --------------------------------------------------------------
  startBtn.addEventListener('click', () => {
    socket.emit('host:start', { seedSentence: seedInput.value });
  });

  approveBtn.addEventListener('click', () => {
    sfx.approve();
    socket.emit('host:approve');
  });

  skipBtn.addEventListener('click', () => {
    socket.emit('host:skip');
  });

  endStoryBtn.addEventListener('click', () => {
    socket.emit('host:endStory');
  });

  startVotingBtn.addEventListener('click', () => {
    socket.emit('host:startVoting');
  });

  endVotingBtn.addEventListener('click', () => {
    socket.emit('host:endVoting');
  });

  newStoryBtn.addEventListener('click', () => {
    seedInput.value = '';
    socket.emit('host:newStory');
  });

  endSessionBtn.addEventListener('click', () => {
    if (confirm('هل أنت متأكد من إنهاء الجلسة بالكامل؟')) {
      sessionStorage.removeItem('qj_hostRoomCode');
      socket.emit('host:endSession');
    }
  });
})();
