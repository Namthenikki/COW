/* ═══════════════════════════════════════════════════════
   Landing Page — CoWatch
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Canvas Background Animation ───
  const canvas = document.getElementById('bg-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let particles = [];
    const PARTICLE_COUNT = 60;
    const CONNECT_DISTANCE = 150;
    let mouseX = -1000, mouseY = -1000;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    class Particle {
      constructor() {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = (Math.random() - 0.5) * 0.5;
        this.radius = Math.random() * 2 + 0.5;
        this.hue = Math.random() > 0.5 ? 190 : 214; // cyan or blue
        this.alpha = Math.random() * 0.4 + 0.1;
      }

      update() {
        this.x += this.vx;
        this.y += this.vy;

        if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
        if (this.y < 0 || this.y > canvas.height) this.vy *= -1;

        // Mouse attraction
        const dx = mouseX - this.x;
        const dy = mouseY - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 200) {
          this.x += dx * 0.002;
          this.y += dy * 0.002;
        }
      }

      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${this.hue}, 100%, 70%, ${this.alpha})`;
        ctx.fill();
      }
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new Particle());
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update and draw particles
      for (const p of particles) {
        p.update();
        p.draw();
      }

      // Draw connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECT_DISTANCE) {
            const alpha = (1 - dist / CONNECT_DISTANCE) * 0.12;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(0, 229, 255, ${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(animate);
    }
    animate();

    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    });
  }

  // ─── UI Logic ───
  const nameInput = document.getElementById('name-input');
  const createBtn = document.getElementById('create-room-btn');
  const showJoinBtn = document.getElementById('show-join-btn');
  const joinSection = document.getElementById('join-section');
  const roomCodeInput = document.getElementById('room-code-input');
  const joinBtn = document.getElementById('join-room-btn');

  // Toggle join section
  showJoinBtn.addEventListener('click', () => {
    const isActive = joinSection.classList.toggle('active');
    if (isActive) {
      showJoinBtn.innerHTML = '<i class="ph ph-x"></i> Cancel';
      roomCodeInput.focus();
    } else {
      showJoinBtn.innerHTML = '<i class="ph ph-sign-in"></i> Join a Room';
    }
  });

  // Create room
  createBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Anonymous';
    window.location.href = `/room.html?host=true&name=${encodeURIComponent(name)}`;
  });

  // Join room
  function joinRoom() {
    const name = nameInput.value.trim() || 'Anonymous';
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) {
      roomCodeInput.focus();
      roomCodeInput.style.borderColor = '#ef4444';
      setTimeout(() => roomCodeInput.style.borderColor = '', 1500);
      return;
    }
    window.location.href = `/room.html?room=${code}&name=${encodeURIComponent(name)}`;
  }

  joinBtn.addEventListener('click', joinRoom);
  roomCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  // Auto-uppercase room code
  roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.toUpperCase();
  });

  // Enter on name input -> create room
  nameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      if (joinSection.classList.contains('active')) {
        roomCodeInput.focus();
      } else {
        createBtn.click();
      }
    }
  });

})();
