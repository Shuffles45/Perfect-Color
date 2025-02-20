/**********************
 * GLOBAL VARIABLES
 **********************/
let currentCandidate = ""; // Current chosen HEX color.
let roundIndex = 0;
const minRounds = 7;         // Minimum rounds before checking termination.
const maxRounds = 15;        // Maximum rounds allowed.
const refinementThreshold = 3; // If ΔE between rounds is below this, stop refining.
let predictedTotalRounds = maxRounds; // Predicted total rounds (updated dynamically).
const baseDecayFactor = 1.5; // Base decay for candidate perturbation.
const historyStack = [];

const contentDiv = document.getElementById('content');
const canvasSize = 300;

/**********************
 * UTILITY FUNCTIONS
 **********************/
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomFloat(min, max) { return Math.random() * (max - min) + min; }

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}
function rgbToHex({ r, g, b }) {
  const toHex = c => { let hex = c.toString(16); return hex.length === 1 ? '0' + hex : hex; };
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

/**********************
 * HSV to RGB Conversion (for the color box)
 **********************/
function hsvToRgb(h, s, v) {
  let c = v * s;
  let x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  let m = v - c;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/**********************
 * CIELAB CONVERSION FUNCTIONS
 **********************/
function rgbToLab(rgb) {
  let r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  r = (r > 0.04045) ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = (g > 0.04045) ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = (b > 0.04045) ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
  let X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  let Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  X /= 0.95047; Z /= 1.08883;
  function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t + 16 / 116); }
  const fx = f(X), fy = f(Y), fz = f(Z);
  const L = (Y > 0.008856) ? (116 * fy - 16) : (903.3 * Y);
  const a = 500 * (fx - fy);
  const b_val = 200 * (fy - fz);
  return { L, a, b: b_val };
}
function labToRgb(lab) {
  let { L, a, b } = lab;
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  function fInv(t) { return (t * t * t > 0.008856) ? t * t * t : ((t - 16 / 116) / 7.787); }
  let X = fInv(x) * 0.95047, Y = fInv(y) * 1.00000, Z = fInv(z) * 1.08883;
  let r = X * 3.2406 + Y * (-1.5372) + Z * (-0.4986);
  let g = X * (-0.9689) + Y * 1.8758 + Z * 0.0415;
  let b_val = X * 0.0557 + Y * (-0.2040) + Z * 1.0570;
  function gammaCorrect(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return clamp(Math.round(c * 255), 0, 255); }
  return { r: gammaCorrect(r), g: gammaCorrect(g), b: gammaCorrect(b_val) };
}

/**********************
 * Advanced ΔE Calculation (Simplified CIEDE2000)
 **********************/
function deltaE2000(lab1, lab2) {
  const dL = lab2.L - lab1.L;
  const da = lab2.a - lab1.a;
  const db = lab2.b - lab1.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**********************
 * PREDICT TOTAL ROUNDS BASED ON INITIAL COLOR
 **********************/
function predictTotalRounds(initialCandidate) {
  // Use the LAB a and b values (colorfulness) to predict total rounds.
  const lab = rgbToLab(hexToRgb(initialCandidate));
  const abMag = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  // Heuristic: abMag = 0 (neutral) => minRounds; abMag = 150 (very saturated) => maxRounds.
  const predicted = Math.round(minRounds + (abMag / 150) * (maxRounds - minRounds));
  return Math.max(minRounds, Math.min(predicted, maxRounds));
}

/**********************
 * DYNAMIC CANDIDATE GENERATION IN CIELAB SPACE
 **********************/
function generateCandidateLabDynamic(currentLab, roundIndex) {
  let LDelta = 15 / Math.pow(baseDecayFactor, roundIndex);
  let aDelta = 20 / Math.pow(baseDecayFactor, roundIndex);
  let bDelta = 20 / Math.pow(baseDecayFactor, roundIndex);
  const targetDelta = 10;
  const tolerance = 2;
  let candidate, deltaE;
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    candidate = {
      L: clamp(currentLab.L + randomFloat(-LDelta, LDelta), 0, 100),
      a: clamp(currentLab.a + randomFloat(-aDelta, aDelta), -128, 127),
      b: clamp(currentLab.b + randomFloat(-bDelta, bDelta), -128, 127)
    };
    deltaE = deltaE2000(candidate, currentLab);
    if (Math.abs(deltaE - targetDelta) < tolerance) break;
    else if (deltaE < targetDelta) { LDelta *= 1.1; aDelta *= 1.1; bDelta *= 1.1; }
    else { LDelta *= 0.9; aDelta *= 0.9; bDelta *= 0.9; }
  }
  return candidate;
}

/**********************
 * ARRAY SHUFFLE (Fisher-Yates)
 **********************/
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**********************
 * FADE TRANSITION HELPER
 **********************/
function fadeTransition(newContentFunction) {
  contentDiv.classList.add('fade-out');
  setTimeout(() => { newContentFunction(); contentDiv.classList.remove('fade-out'); }, 800);
}

/**********************
 * UPDATE PROGRESS DISPLAY
 **********************/
function updateProgressDisplay() {
  const progressText = `Round ${roundIndex+1} of ${predictedTotalRounds}: Which option looks best?`;
  const progressParagraph = document.getElementById('progress-text');
  if (progressParagraph) {
    progressParagraph.textContent = progressText;
  }
  const progressBar = document.getElementById('progress-bar');
  if (progressBar) {
    progressBar.style.width = `${(roundIndex / predictedTotalRounds) * 100}%`;
  }
}

/**********************
 * STAGE: COLOR BOX SELECTION
 **********************/
function displayColorBox() {
  fadeTransition(() => {
    contentDiv.innerHTML = `
      <p>Choose your starting color:</p>
      <div id="colorPickerContainer">
        <input type="range" id="hueSlider" min="0" max="360" value="0" />
        <br/>
        <canvas id="colorBox" width="${canvasSize}" height="${canvasSize}"></canvas>
      </div>
      <p>Click on the box to select a color (adjust saturation and brightness).</p>
    `;
    const hueSlider = document.getElementById('hueSlider');
    const colorBox = document.getElementById('colorBox');
    drawColorBox(colorBox, hueSlider.value);
    hueSlider.addEventListener('input', () => { drawColorBox(colorBox, hueSlider.value); });
    colorBox.addEventListener('click', event => {
      const rect = colorBox.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const s = x / canvasSize, v = 1 - y / canvasSize;
      const h = parseFloat(hueSlider.value);
      const rgb = hsvToRgb(h, s, v);
      currentCandidate = rgbToHex(rgb);
      roundIndex = 0;
      historyStack.length = 0;
      // Predict the total rounds based on the initial candidate.
      predictedTotalRounds = predictTotalRounds(currentCandidate);
      displayRound();
    });
  });
}

function drawColorBox(canvas, hue) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const s = x / canvas.width, v = 1 - y / canvas.height;
      const { r, g, b } = hsvToRgb(hue, s, v);
      const index = (y * canvas.width + x) * 4;
      imageData.data[index] = r;
      imageData.data[index+1] = g;
      imageData.data[index+2] = b;
      imageData.data[index+3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**********************
 * STAGE: ROUNDS (Dynamic Candidate Generation with Dynamic Total)
 **********************/
function displayRound() {
  // Check for dynamic termination if we've completed at least minRounds.
  if (roundIndex >= minRounds && historyStack.length > 0) {
    const prevCandidate = historyStack[historyStack.length - 1].candidate;
    const diff = deltaE2000(rgbToLab(hexToRgb(currentCandidate)), rgbToLab(hexToRgb(prevCandidate)));
    if (diff < refinementThreshold) {
      predictedTotalRounds = roundIndex;
      displayFinalResult();
      return;
    }
  }
  // If we've reached maxRounds, finish.
  if (roundIndex >= maxRounds) {
    predictedTotalRounds = maxRounds;
    displayFinalResult();
    return;
  }
  
  // Otherwise, continue with the round.
  const currentRGB = hexToRgb(currentCandidate);
  const currentLab = rgbToLab(currentRGB);
  const candidate1Lab = generateCandidateLabDynamic(currentLab, roundIndex);
  const candidate2Lab = generateCandidateLabDynamic(currentLab, roundIndex);
  const candidate1Hex = rgbToHex(labToRgb(candidate1Lab));
  const candidate2Hex = rgbToHex(labToRgb(candidate2Lab));
  const options = [
    { hex: currentCandidate, label: "Keep Current" },
    { hex: candidate1Hex, label: "New Option" },
    { hex: candidate2Hex, label: "New Option" }
  ];
  shuffleArray(options);
  fadeTransition(() => {
    contentDiv.innerHTML = `
      <p id="progress-text">Round ${roundIndex+1} of ${predictedTotalRounds}: Which option looks best?</p>
      <div id="progress-container">
        <div id="progress-bar" style="width:${(roundIndex/predictedTotalRounds)*100}%"></div>
      </div>
    `;
    const buttonsContainer = document.createElement('div');
    buttonsContainer.classList.add('buttons-container');
    options.forEach(option => {
      const btn = document.createElement('button');
      btn.classList.add('color-button');
      btn.style.backgroundColor = option.hex;
      btn.addEventListener('click', () => {
        historyStack.push({ candidate: currentCandidate, round: roundIndex });
        currentCandidate = option.hex;
        roundIndex++;
        displayRound();
      });
      buttonsContainer.appendChild(btn);
    });
    contentDiv.appendChild(buttonsContainer);
    const backButton = document.createElement('button');
    backButton.id = "back";
    backButton.textContent = "Back";
    backButton.addEventListener('click', () => {
      if (historyStack.length > 0) {
        const prev = historyStack.pop();
        currentCandidate = prev.candidate;
        roundIndex = prev.round;
        displayRound();
      } else { displayColorBox(); }
    });
    contentDiv.appendChild(backButton);
    updateProgressDisplay();
  });
}

/**********************
 * STAGE: FINAL RESULT (Save & Share Photo)
 **********************/
function displayFinalResult() {
  localStorage.setItem("lastColor", currentCandidate);
  fadeTransition(() => {
    contentDiv.innerHTML = `
      <p class="result">Your perfect color is:</p>
      <div class="final-color" style="background-color: ${currentCandidate};"></div>
      <p>Hex Code: ${currentCandidate}</p>
      <button id="share">Share</button>
      <button id="restart">Try Again</button>
    `;
    document.getElementById('restart').addEventListener('click', resetAll);
    document.getElementById('share').addEventListener('click', shareColorPhoto);
  });
}

/**********************
 * SHARE PHOTO FUNCTIONALITY (Enhanced Image with Watermark)
 **********************/
function shareColorPhoto() {
  const shareCanvas = document.getElementById('shareCanvas');
  const ctx = shareCanvas.getContext('2d');
  shareCanvas.width = 500;
  shareCanvas.height = 500;
  
  // Create a pleasing radial background gradient
  const bgGradient = ctx.createRadialGradient(250, 250, 50, 250, 250, 250);
  bgGradient.addColorStop(0, "#fdfbfb");
  bgGradient.addColorStop(1, "#e9ecef");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, 500, 500);
  
  // Draw a softly shadowed circle with the perfect color
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 20;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 10;
  ctx.beginPath();
  ctx.arc(250, 200, 120, 0, 2 * Math.PI);
  ctx.fillStyle = currentCandidate;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#333";
  ctx.stroke();
  ctx.restore();
  
  // Write the title text
  ctx.font = "bold 32px 'Roboto', sans-serif";
  ctx.fillStyle = "#333";
  ctx.textAlign = "center";
  ctx.fillText("My Perfect Color", 250, 360);
  
  // Write the HEX code below
  ctx.font = "28px 'Roboto', sans-serif";
  ctx.fillStyle = "#555";
  ctx.fillText(currentCandidate, 250, 410);
  
  // Add a watermark with link in the bottom right corner
  ctx.font = "16px 'Roboto', sans-serif";
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.textAlign = "right";
  ctx.fillText("Perfect Color - shuffles45.github.io/Perfect-Color", 490, 490);
  
  // Convert canvas to blob and share or download
  shareCanvas.toBlob(blob => {
    const file = new File([blob], "perfect_color.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({
        title: "My Perfect Color",
        text: `I found my perfect color: ${currentCandidate}`,
        files: [file]
      }).catch(() => { /* Handle error silently */ });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "perfect_color.png";
      a.click();
    }
  });
}

/**********************
 * RESET FUNCTION
 **********************/
function resetAll() {
  currentCandidate = "";
  roundIndex = 0;
  historyStack.length = 0;
  displayColorBox();
}

/**********************
 * INITIALIZE APP
 **********************/
displayColorBox();
