(() => {
  const socket = io();

  const params = new URLSearchParams(window.location.search);
  const roomCode = (params.get('room') || '').toUpperCase().trim();
  const storageKey = `qj_player_${roomCode}`;

  // ---- Elements -------------------------------------------------------
  const phases = {
    join: document.getElementById('joinPhase'),
    waiting: document.getElementById('waitingPhase'),
    writing: document.getElementById('writingPhase'),
    reveal: document.getElementById('revealPhase'),
    voting: document.getElementById('votingPhase'),
    results: document.getElementById('resultsPhase'),
    ended: document.getElementById('endedPhase')
  };

  const joinForm = document.getElementById('joinForm');
  const nameInput = document.getElementById('nameInput');

  const waitingName = document.getElementById('waitingName');
  const waitingPlayerList = document.getElementById('waitingPlayerList');

  const pausedMsg = document.getElementById('pausedMsg');
  const yourTurnArea = document.getElementById('yourTurnArea');
  const contextCards = document.getElementById('contextCards');
  const timerText = document.getElementById('timerText');
  const lineInput = document.getElementById('lineInput');
  const submitLineBtn = document.getElementById('submitLineBtn');
  const submittedMsg = document.getElementById('submittedMsg');
  const otherTurnArea = document.getElementById('otherTurnArea');
  const otherTurnBanner = document.getElementById('otherTurnBanner');
  const otherTimerText = document.getElementById('otherTimerText');

  const revealStory = document.getElementById('revealStory');

  const voteList = document.getElementById('voteList');
  const votedMsg = document.getElementById('votedMsg');

  const winnersTitle = document.getElementById('winnersTitle');
  const winnersContainer = document.getElementById('winnersContainer');
  const resultsStory = document.getElementById('resultsStory');

  const errorToast = document.getElementById('errorToast');

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

  function renderContextCards(container, context) {
    container.innerHTML = '';
    for (const line of context) {
      const div = document.createElement('div');
      div.className = 'context-card';
      div.textContent = line.text;
      container.appendChild(div);
    }
  }

  function renderPlayerList(ul, players) {
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'player-chip';
      if (!p.connected) li.classList.add('disconnected');
      li.textContent = p.name;
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

  function renderVoteList(state) {
    voteList.innerHTML = '';
    const lines = state.story.filter(l => l.lineNo > 0);
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = 'vote-option';
      if (line.isOwn) div.classList.add('disabled');
      if (state.you.hasVoted) {
        div.classList.add('disabled');
        if (state.you.yourVote === line.lineNo) div.classList.add('selected');
      }
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = line.lineNo;
      const text = document.createElement('span');
      text.textContent = line.text;
      div.appendChild(num);
      div.appendChild(text);

      if (!line.isOwn && !state.you.hasVoted) {
        div.addEventListener('click', () => {
          socket.emit('player:vote', { lineNo: line.lineNo });
        });
      }
      voteList.appendChild(div);
    }
    votedMsg.hidden = !state.you.hasVoted;
  }

  // ---- Main render ---------------------------------------------------------
  function render(state) {
    showPhase(state.phase === 'lobby' ? 'waiting' : state.phase);

    if (state.phase === 'lobby') {
      waitingName.textContent = state.you.name;
      renderPlayerList(waitingPlayerList, state.players);
    }

    if (state.phase === 'writing') {
      pausedMsg.classList.toggle('hidden', !state.paused);

      if (!state.paused) {
        if (state.you.isYourTurn) {
          yourTurnArea.classList.remove('hidden');
          otherTurnArea.classList.add('hidden');
          renderContextCards(contextCards, state.context || []);
          timerText.textContent = state.secondsLeft;
          timerText.classList.toggle('low', state.secondsLeft <= 5);

          if (state.you.hasSubmitted) {
            lineInput.disabled = true;
            submitLineBtn.disabled = true;
            submittedMsg.hidden = false;
          } else {
            lineInput.disabled = false;
            submitLineBtn.disabled = false;
            submittedMsg.hidden = true;
          }
        } else {
          yourTurnArea.classList.add('hidden');
          otherTurnArea.classList.remove('hidden');
          const current = state.players.find(p => p.id === state.currentTurnPlayerId);
          otherTurnBanner.textContent = current ? `دور ${current.name} الآن…` : '';
          otherTimerText.textContent = state.secondsLeft;
          otherTimerText.classList.toggle('low', state.secondsLeft <= 5);
        }
      } else {
        yourTurnArea.classList.add('hidden');
        otherTurnArea.classList.add('hidden');
      }
    }

    if (state.phase === 'reveal') {
      renderStoryLines(revealStory, state.story);
    }

    if (state.phase === 'voting') {
      renderVoteList(state);
    }

    if (state.phase === 'results') {
      renderWinners(state);
      renderStoryLines(resultsStory, state.story);
    }
  }

  // ---- Socket events --------------------------------------------------------
  socket.on('connect', () => {
    if (!roomCode) {
      showError('رمز الجلسة مفقود من الرابط.');
      return;
    }
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved && saved.playerId) {
      socket.emit('player:reconnect', { roomCode, playerId: saved.playerId });
    } else {
      showPhase('join');
    }
  });

  socket.on('player:joined', ({ playerId, name }) => {
    sessionStorage.setItem(storageKey, JSON.stringify({ playerId, name }));
  });

  socket.on('state', (state) => {
    render(state);
  });

  socket.on('turn:tick', ({ secondsLeft }) => {
    if (phases.writing.classList.contains('hidden')) return;
    if (!yourTurnArea.classList.contains('hidden')) {
      timerText.textContent = secondsLeft;
      timerText.classList.toggle('low', secondsLeft <= 5);
    } else if (!otherTurnArea.classList.contains('hidden')) {
      otherTimerText.textContent = secondsLeft;
      otherTimerText.classList.toggle('low', secondsLeft <= 5);
    }
  });

  socket.on('error:msg', ({ code, text }) => {
    showError(text);
    if (code === 'PLAYER_NOT_FOUND') {
      sessionStorage.removeItem(storageKey);
      showPhase('join');
    }
  });

  socket.on('session:ended', () => {
    sessionStorage.removeItem(storageKey);
    showPhase('ended');
  });

  // ---- UI events --------------------------------------------------------------
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    socket.emit('player:join', { roomCode, name });
  });

  submitLineBtn.addEventListener('click', () => {
    const text = lineInput.value.trim();
    if (!text) return;
    socket.emit('player:submitLine', { text });
    lineInput.value = '';
  });
})();
