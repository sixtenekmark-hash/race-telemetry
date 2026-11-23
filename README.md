# Race Telemetry

A live dashboard for the car's eChook logger, built for the person on the pit wall
who tells the drivers when to speed up and when to slow down.

## The ideal Ah

The main number on the **Race** tab compares the amp-hours used so far with an ideal.
Choose the ideal in **Settings → Energy plan**. The coefficients can be edited there.

| Model | Ideal Ah | t and n |
|---|---|---|
| **C(t, n)** (default) | 0.12 + 0.137t + 0.249n | t = minutes since the race start; n = laps completed (0 on lap 1) |
| **C(t)** | 0.14 + 0.2388t | t = minutes since the race start |
| **Reference race** | 20 Ah ÷ 33 laps ÷ 149.070 s × time | the original method, described below |

Settings can switch n to "the lap in progress" (1 on lap 1), which raises the ideal by 0.249 Ah throughout.

The dashboard shows **actual − ideal** as **+x Ah** or **−x Ah**:
- **+** means more was used than the ideal: **SLOW DOWN**.
- **−** means less was used: **SPEED UP**.
- Within ± the band (0.2 Ah by default): **ON PACE**.

The laps table and last-lap card compare each lap with how much the ideal grows over a lap of
that length:

| Model | Ideal for one lap |
|---|---|
| C(t, n) | 0.137 × lap minutes + 0.249 |
| C(t) | 0.2388 × lap minutes |
| Reference race | 0.6061 Ah |

Checked against the 1 Dec 2025 race:
- C(t) is exactly the least-squares fit of the app's AmpHours against minutes since the log started.
- With C(t, n), Δ Ah at each lap line stayed between −0.19 and +0.01 Ah.
- Within a lap, C(t, n) swings by about 0.3 Ah. The ideal grows only 0.137 Ah/min between lines,
  then steps up 0.249 Ah at each line. Read it at the line, or use C(t) for a steadier mid-lap call.

The **Hold for the rest** figure is the steady current that would use exactly the rest of the
20 Ah target in the time left in the race plan.

### Reference race method

1. Target for a race: **20 Ah**.
2. Reference race (1 Dec 2025, eChook app CSV): **33 complete laps**, counted from GPS.
3. Ah per lap = 20 ÷ 33 = **0.6061 Ah**.
4. Average lap = **149.070 s**, including the two pit stops.
5. Ah per second = 0.6061 ÷ 149.070 = **0.0040656 Ah/s** = 4.0656 × 10⁻⁶ Ah/ms
   (the same as a steady 14.64 A). This covers 33 × 149.070 s = 81 min 59 s, which is also the
   race length used for "hold for the rest" unless one is set.
6. The ideal at any moment is that rate × the time since the race started.

**Data & replay → Use as pacing reference** redoes steps 2–5 from any race log.

## Race day controls (Race tab)

- **Start race** starts the race clock at once. The start, any laps marked by hand, the race class
  and the ideal model are **shared with every device that has the Car ID**, so all of them show the
  same clock and laps. A device that was closed catches up when it opens again.
  - The sharing goes through ntfy.sh, a free message relay that keeps messages for 12 hours. The
    channel name is a one-way hash of the Car ID, so the Car ID itself is never sent.
  - Only these small events are shared, never telemetry.
- **Lap** (key **L**) marks a lap at the line, for when GPS lap counting is unreliable.
  - As soon as one lap is marked by hand, automatic lap counting is off for that race.
  - **Undo lap** (key **U**) removes the last marked lap. A second press within 10 s is ignored.
  - **Back to automatic laps** deletes the hand-marked laps.
- **F24 / F24+** switches the race class. Each class has its own numbers in Settings:

  | | F24 | F24+ |
  |---|---|---|
  | Aim (race length) | 1.5 h | 1 h |
  | Reference race (1 Dec 2025) | 33 laps, 149.070 s | 26 laps, 144.155 s |
  | C(t, n) | 0.12 + 0.137t + 0.249n (the team's) | 1.684 + 0.2385t + 0.0956n (fitted to the F24+ log) |
  | C(t) | 0.14 + 0.2388t (the team's) | 1.3963 + 0.2811t (fitted to the F24+ log) |

- **Ah used (race)** counts from the race start and resets when the race is restarted. It is worked
  out from the eChook's own amp-hour counter, and the pace call uses it.
- **eChook Ah counter** shows the eChook's own total, exactly as eChook shows it. If the phone app
  restarts mid-race and the counter falls back to zero, the earlier total is carried over.
- **Motor RPM** is worked out exactly from the eChook speed reading.
  - The eChook's speed input counts the magnet on the motor shaft. The eChook turns that into a speed
    using the wheel size, so the speed it reports is motor turns per second × 2π × wheel radius ÷ magnets.
  - The site works backwards: RPM = eChook speed (m/s) × 60 × magnets ÷ (2π × wheel radius). With a
    25 cm wheel radius and 1 magnet, that is speed in m/s × 38.2, or speed in km/h × 10.6.
  - Only the eChook speed can be used for this. GPS speed is the car's real speed, which doesn't say how
    fast the motor turns.
  - The wheel radius and magnet count are in Settings. The earlier rule (89 km/h = 2400 rpm, range
    2200–2500) can still be chosen there.
- **The map** can zoom and pan, and switches between satellite and street maps. Click the track to
  see the readings at that point. ◎ follows the car and ⤢ shows the whole track.

## Last lap summary

The eChook's own last-lap fields (`LL_Time`, `LL_Ah`, …) arrive empty in every packet, even in
races where its lap counter works. The dashboard therefore works the summary out itself from the
lap counter and the raw readings, as eChook's own website does. Each lap gets:

- time
- Ah used compared with the plan
- average and peak current
- average and lowest voltage
- wheel speed and GPS speed
- RPM, throttle, Wh and peak temperature

If the lap counter isn't counting, laps come from a GPS start/finish line instead. That line is
placed where the car drives off, or set by hand in Settings.

Live packets arrive about every 3 s, so lap times from the counter are accurate to about ±3 s.

## Running it on this computer

```bash
cd ~/Documents/echook-telemetry
node server.js
```

Then open <http://localhost:5173>. The Car ID is read from `.env`, which is never published.

To check the calculations against real logs:

```bash
node tools/check.mjs data/race-2025-12-01.tsv
```

## Putting it on a public address

There are two versions of the site. Both come from this folder.

| | Static (GitHub Pages) | Full (Render, or any Node host) |
|---|---|---|
| Live data, pace call, laps, graphs, map | ✓ | ✓ |
| Replay of eChook app CSV files | ✓ | ✓ |
| Past days from eChook's history | – (eChook blocks other websites) | ✓ |
| Page reloaded mid-race | Restores what this browser saw | Restores the whole day from eChook |
| Car ID | Typed in once per device, kept in that browser | Kept on the server (`CAR_ID`) |
| Team password | – | `SITE_PASSWORD` |

**Static version:** `.github/workflows/pages.yml` publishes `public/` whenever you push to `main`.

**Full version on Render:**

1. Connect the repository on render.com. `render.yaml` sets the service up.
2. Enter `CAR_ID` and `SITE_PASSWORD` when Render asks for them.

On the free plan the server sleeps after 15 minutes without visitors. The first visit after that
takes about a minute, so open the page before the race starts. Live data comes straight from
eChook to the browser, so a sleeping server does not interrupt it.

Without `SITE_PASSWORD` the server only accepts connections from the computer it runs on.

## Things noticed in the data

- `temp2` is always 0 and `brake` is never on, so those sensors look unconnected.
- On 12 Nov the GPS shows the car moving at about 11 mph while wheel speed and RPM read 0.
  The wheel speed tile warns when this happens.
- Spikes (for example 304 m/s or 4000 rpm) are dropped before anything is calculated.
- Warning thresholds follow eChook's:
  - voltage below 18 V (warning) and 14 V (critical)
  - temperature above 55 °C and 65 °C
  - current above 40 A and 120 A
  - battery imbalance above 0.5 V
