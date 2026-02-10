// Condensed tip bank extracted from Sim Racing University course content (120k words).
// Used by emailBrain.js to generate authentic broadcast emails.
// Each topic contains a title, core insight, analogy/example, and actionable takeaway.
// ~3500 words — keeps API costs low while providing rich, varied content.

const tipBank = [
  // === BRANCH 1: Physical Fundamentals ===
  {
    topic: 'Hand Position: 9 and 3',
    insight: 'Thumbs hooked over the spokes at 9 and 3 serve as tactile anchors — like the bumps on F and J keys for touch typists. During a spin or disorientation, your thumb position tells you exactly where the wheels are pointing without looking.',
    actionable: 'Hook your thumbs over the spokes and try to keep your hands at 9 and 3 for 90% of a lap. Only move them for hairpins under 50 km/h.',
  },
  {
    topic: 'Push-Pull Steering Balance',
    insight: 'Most drivers only pull with the bottom hand. The top hand (pushing) is actually better for precision, while the bottom hand (pulling) provides power. Using both 50/50 cuts fatigue dramatically and makes steering smoother.',
    actionable: 'Try wrapping your thumbs around the rim temporarily — it forces you to push with the top hand since you can\'t pull. Run 5-10 laps, then return to normal grip while keeping the balanced technique.',
  },
  {
    topic: 'Steering Fatigue is a Technique Problem',
    insight: 'If your arms tire after 30 minutes, the problem is usually technique, not fitness. Four culprits: imbalanced effort (one arm overworked), death-grip on the wheel, shrugged shoulders, or poor seating position. Fix these before adding gym time.',
    actionable: 'During a straight, check your shoulders — if your traps feel tight, consciously drop them. Then check your grip — you only need about 30-40% of max grip strength to maintain control.',
  },
  {
    topic: 'Full-Body Steering',
    insight: 'Like a golf swing, optimal steering is a kinetic chain: core stability → shoulder platform → upper arms as primary movers → forearms for fine control → hands connect to wheel. Steering from your fingertips alone is like throwing a punch with just your wrist.',
    actionable: 'Next session, notice if your core engages slightly during turn-in. If you feel nothing in your midsection during aggressive steering, you\'re isolating the movement to your arms.',
  },

  // === BRANCH 2: Vision & Awareness ===
  {
    topic: 'The #1 Vision Mistake',
    insight: 'Looking at your car\'s nose makes 100 km/h feel chaotic. Looking 50+ meters ahead makes the same speed feel manageable. At 100 km/h you cover 28m per second — if you\'re looking 3 meters ahead, you\'re past the information before your brain processes it.',
    actionable: 'Force your eyes to the furthest visible point. The track "slows down" within 3-5 laps. Push through the initial discomfort — your instincts want to watch what\'s happening now, not what\'s coming.',
  },
  {
    topic: 'Your Car Follows Your Eyes',
    insight: 'Your hands subconsciously steer toward your focal point through the vestibular-ocular reflex. Target fixation (staring at a wall and hitting it) is the negative version. Use it positively: look at the apex, hands guide to apex. Look at the exit, hands guide to exit.',
    actionable: 'Practice the vision sequence: approach = look at turn-in point → braking = shift to apex → turn-in = shift to exit → exit = look down the next straight. Your eyes should always lead the car by 1-2 seconds.',
  },
  {
    topic: 'Peripheral Vision for Early Warnings',
    insight: 'Your central vision handles detail; peripheral vision handles motion detection. Elite drivers keep central focus far ahead while using peripheral vision to detect early signs of trouble — a slight drift of the rear, a competitor closing, tire debris ahead.',
    actionable: 'Don\'t dart your eyes around trying to see everything. Fix your gaze on the far reference point and let your peripheral vision handle the rest. You\'ll actually notice more, not less.',
  },

  // === BRANCH 3-4: Core Theory & Weight Transfer ===
  {
    topic: 'The 100 Grip Units Model',
    insight: 'Your car has 100 units of grip spread across 4 tires. Braking shifts units forward, acceleration shifts them rearward, cornering shifts them outside. The total stays at 100, but here\'s the catch: the tire gaining load doesn\'t gain grip as fast as the tire losing load loses grip. Weight transfer literally shrinks your grip budget.',
    actionable: 'Think of every input as redistributing your grip budget. Smooth inputs keep the distribution even — aggressive inputs create a 50-5-40-5 split where one tire does all the work and your total grip drops.',
  },
  {
    topic: 'The Water Cup Analogy',
    insight: 'Imagine a cup of water on your dashboard. Every input sloshes it. Smooth inputs create gentle ripples. Abrupt inputs create waves that take time to settle. The fastest drivers don\'t minimize inputs — they time them to work with the water\'s momentum.',
    actionable: 'Start turning as brake pressure releases, so forward slosh transitions into lateral slosh smoothly instead of fighting it. The goal isn\'t being gentle — it\'s managing transitions between states.',
  },
  {
    topic: 'Why "Smooth is Fast"',
    insight: '"Smooth is fast" doesn\'t mean slow. It means efficient weight transfer. When you slam the brakes, the car pitches forward violently. While the suspension oscillates trying to settle, your grip is unstable. A smooth application reaches the same peak pressure faster because the car cooperates instead of fighting.',
    actionable: 'Focus on how quickly your car settles after each input. If the car is still pitching when you start turning, your inputs are fighting each other.',
  },

  // === BRANCH 5-6: Racing Line & Corner Priority ===
  {
    topic: 'Exit Speed Trumps Everything',
    insight: 'A corner leading onto a long straight is worth more than a corner in the middle of a technical section. If you carry 2 km/h more exit speed onto a 1km straight, you gain that advantage for the entire straight. The same 2 km/h between two corners only helps for 100 meters.',
    actionable: 'Identify the corners that lead onto straights at your track. These are your "Type 1" corners — sacrifice everything else to nail these exits.',
  },
  {
    topic: 'Why Late Braking Backfires',
    insight: 'Braking 5 meters later saves about 0.06 seconds. But if that late braking compromises your exit speed by just 3 km/h, you lose 0.15 seconds on the following straight. Late braking is a net loss unless your exit speed stays the same.',
    actionable: 'Next time you\'re tempted to out-brake yourself, focus on exit speed instead. You\'ll almost certainly gain more time accelerating out than you saved braking in.',
  },
  {
    topic: 'Use Every Inch of Track',
    insight: 'Your car has a minimum turning radius at any given speed. The wider the arc you can use, the faster you can take the corner. Starting at the outside edge, clipping the inside apex, and using the full outside on exit creates the widest possible arc through the corner.',
    actionable: 'Check your replays — are your wheels touching the edge of the track at entry, apex, AND exit? Most drivers leave 30-50cm unused. That\'s free speed.',
  },

  // === BRANCH 7-8: Corner Stages & Track Learning ===
  {
    topic: 'The 5 Stages of Every Corner',
    insight: 'Every corner has 5 stages: 1) Hard braking (straight line), 2) Initial rotation (trail brake + turn-in), 3) Peak rotation (slowest point/apex), 4) Exit setup (unwinding + initial throttle), 5) Exit (full throttle + straightening). Knowing which stage you\'re in prevents panicked inputs.',
    actionable: 'Pick one corner and consciously identify each stage as you drive through it. Once you can feel the transitions, your timing improves naturally.',
  },
  {
    topic: 'Learn the Line First, Then Push',
    insight: 'Most drivers try to drive at the limit on an unfamiliar track immediately. This teaches bad lines at high stress. Instead: Stage 1 is discover the correct line at 70-80% pace. Stage 2 is push to the limit on that correct line. Bad lines practiced at speed become deeply ingrained bad habits.',
    actionable: 'First 10 laps on a new track: focus only on hitting 4 reference points per corner (entry, turn-in, apex, exit) at moderate pace. Speed comes after the line is consistent.',
  },

  // === BRANCH 9: Steering Technique ===
  {
    topic: 'Egg-Holding Grip',
    insight: 'Imagine holding an egg — firm enough not to drop it, light enough not to crack it. That\'s your ideal steering grip pressure. A death grip fatigues your forearms, masks force feedback information, and makes micro-adjustments jerky instead of smooth.',
    actionable: 'Start a lap at your normal grip pressure, then consciously lighten it by 50%. The wheel\'s force feedback actually tells you more when you\'re not fighting it.',
  },
  {
    topic: 'Force Feedback is Data, Not Resistance',
    insight: 'When the wheel pushes back, most drivers push harder against it. But that resistance IS the car talking to you — it\'s telling you about grip levels, weight transfer, and tire load. Fighting FFB is like shouting over someone trying to give you directions.',
    actionable: 'Let the wheel guide your hands slightly. When it pulls toward a direction under braking, that\'s the car showing you where the grip is. Work with it, not against it.',
  },

  // === BRANCH 10-11: Traction Circle & Oversteer/Understeer ===
  {
    topic: 'The Traction Circle',
    insight: 'Each tire can only produce 100% total force. If you\'re using 80% for braking, you only have 20% left for turning. The traction circle visualizes this — the edge of the circle is the tire\'s limit. Stay inside = safe. Touch the edge = maximum performance. Go outside = spin.',
    actionable: 'The fastest drivers ride the edge of the circle by blending inputs — trail braking uses 70% braking + 30% turning simultaneously, extracting more total performance than doing either alone.',
  },
  {
    topic: 'Understeer: The Common Causes',
    insight: 'Understeer (front pushes wide) has 3 main causes: too much entry speed, too much steering angle, or too early throttle. Most drivers add more steering when they understeer — which makes it worse because the front tires are already over their grip limit.',
    actionable: 'If the car pushes wide, your first instinct should be to reduce speed or reduce steering angle — not add more lock. Less is genuinely more.',
  },
  {
    topic: 'Controlled Oversteer is a Tool',
    insight: 'Small amounts of oversteer actually help rotate the car through tight corners. The rear slides slightly, pointing the car toward the exit earlier. Professional drivers deliberately induce tiny amounts of oversteer through trail braking to improve rotation.',
    actionable: 'In slow corners, try maintaining a touch more trail brake through turn-in. If the rear steps out slightly and the car points toward the exit better, you\'ve found controlled rotation.',
  },

  // === BRANCH 12-13: Braking & Trail Braking ===
  {
    topic: 'Trail Braking: The Biggest Speed Gain',
    insight: 'Trail braking means continuing to brake after turn-in. Two drivers with equal skill — one who straight-line brakes only and one who trail brakes — differ by 0.2-0.4 seconds PER corner. Over 6 major braking zones per lap, that\'s 1.2-2.4 seconds.',
    actionable: 'Start with 10% brake pressure carried past turn-in and release gradually as steering angle increases. Release fully by the apex. Build from there as confidence grows.',
  },
  {
    topic: 'The Brake Release is More Important Than the Brake Application',
    insight: 'Hitting the brakes hard is easy. Releasing them smoothly is the art. Abrupt release dumps front weight transfer right when your front tires need it most for turning. A progressive release keeps the front loaded through the critical turn-in phase.',
    actionable: 'Think of brake release as a controlled squeeze-off, not a sudden lift. The speed of release should match the speed at which you\'re adding steering — slow release for slow corners, quicker release for fast sweepers.',
  },
  {
    topic: 'Reference Points Beat Feel',
    insight: 'Under pressure — rain, traffic, qualifying — your sense of speed and distance degrades. Reference points (a crack in the tarmac, a marshal post, a shadow) give you consistent, repeatable markers that work regardless of stress level. "Feel" fails when adrenaline spikes.',
    actionable: 'For each corner, find a specific visual marker for your brake point. Not "around here somewhere" — a specific object. Consistency comes from repeatable references, not guesswork.',
  },

  // === BRANCH 14-15: Throttle & Turn-In ===
  {
    topic: 'Throttle: "How Much" vs "How Fast"',
    insight: 'Two throttle dimensions matter: how much total throttle you apply, and how quickly you apply it. A driver who slams 60% throttle mid-corner may spin, while a driver who smoothly rolls to 80% throttle exits cleanly. The rate of application matters as much as the amount.',
    actionable: 'Think of initial throttle as "setting the balance" (gentle roll-on) and then modulation as "riding the edge" (adding more as steering unwinds). Two distinct phases.',
  },
  {
    topic: 'Never Unwind Steering Before Accelerating',
    insight: 'Some drivers straighten the wheel first, then floor it. This wastes the entire exit phase. The correct sequence: start throttle while still turning, then progressively unwind steering AS throttle increases. The car straightens because you\'re accelerating, not because you turned the wheel.',
    actionable: 'At the apex, start adding throttle gently. Let the throttle application naturally push the car toward the exit — you\'ll unwind steering as a response to the car tracking out, not as a separate action.',
  },

  // === BRANCH 16-17: Corner Types & Elevation ===
  {
    topic: 'Chicanes: The Imaginary Line',
    insight: 'A chicane isn\'t two separate corners — it\'s one flowing movement. Draw an imaginary line through both apexes. Your car should flow along this line in one smooth motion, not brake-turn-brake-turn as two disconnected corners.',
    actionable: 'In a chicane, look all the way through to the exit of the second element before you even enter the first. Treat the transition point as a brief deceleration, not a full braking zone.',
  },
  {
    topic: 'Crests Kill Grip, Compressions Add It',
    insight: 'Going over a crest (hill top) reduces the effective weight on your tires — like the moment of weightlessness at the top of a roller coaster. Compressions (dips/valleys) increase it. This means you can push harder in dips and must be more patient over crests.',
    actionable: 'If there\'s a crest in your braking zone, ease off the brakes slightly as you go over it — less weight means less grip means the threshold is lower. In compressions, you can actually push the brakes harder.',
  },

  // === BRANCH 18-21: Advanced Topics ===
  {
    topic: 'Engine Braking as a Rotation Tool',
    insight: 'Downshifting during braking adds engine braking force to the driven wheels. In RWD cars, this means extra braking force on the rear — which can help rotate the car into the corner. In FWD cars, it adds force to the front, which can tighten your line.',
    actionable: 'In RWD cars, complete all downshifts during the heavy braking phase when the tires can handle the extra force. Downshifting while turning can cause the rear to snap loose unexpectedly.',
  },
  {
    topic: 'Car Type Changes Everything',
    insight: 'FWD cars pull themselves through corners (throttle = tighter line). RWD cars push from behind (throttle = looser rear). AWD splits the difference. The throttle doesn\'t just make you go faster — it actively changes the car\'s balance.',
    actionable: 'In FWD: use throttle to pull through mid-corner. In RWD: be patient with throttle until the car is pointed straight enough. In AWD: you can be more aggressive earlier but watch for understeer.',
  },
  {
    topic: 'Cold Tires vs Worn Tires',
    insight: 'Cold tires lack grip because the rubber hasn\'t reached optimal temperature — they feel slippery everywhere equally. Worn tires feel normal initially but give up suddenly when pushed hard. Cold tires are predictable (consistently less grip). Worn tires are deceptive (feel fine until they don\'t).',
    actionable: 'First 2-3 laps: operate at 70-80% and use smooth inputs to build heat. With worn tires: reduce your limit expectations by 5-10% and focus on earlier, gentler inputs to stay within the reduced grip window.',
  },
  {
    topic: 'Wet Weather Fundamentals',
    insight: 'In wet conditions, the racing line changes completely. The dry rubber-coated racing line becomes the slipperiest surface. Grip exists off-line where the track surface is rougher and less polished. Braking zones can double in length.',
    actionable: 'Move off the normal racing line in the wet. Brake earlier and more gently. Look for darker patches of tarmac (more textured = more grip) and avoid painted lines, kerbs, and the polished racing line.',
  },
  {
    topic: 'Error Diagnosis: Driver First',
    insight: 'When something goes wrong, most drivers blame the car setup. But 90% of the time, it\'s a driver input causing the issue. The diagnosis loop: 1) What happened? 2) Where in the corner? 3) What was I doing with my inputs? 4) What should I change?',
    actionable: 'Before touching car setup, ask: "Am I trail braking correctly? Is my throttle application too aggressive? Am I turning in at the right point?" Fix your inputs first — you\'ll solve most problems without touching a single setup slider.',
  },
];

// Return a random subset of tips for variety in each broadcast
function getRandomTips(count = 5) {
  const shuffled = [...tipBank].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// Format tips for inclusion in the Claude prompt
function formatTipsForPrompt(tips) {
  return tips.map((t, i) =>
    `${i + 1}. "${t.topic}" — ${t.insight} Actionable: ${t.actionable}`
  ).join('\n\n');
}

module.exports = { tipBank, getRandomTips, formatTipsForPrompt };
