# Race Telemetry

A live dashboard for the car's eChook logger, built for the person on the pit wall
who tells the drivers when to speed up and when to slow down.

## The energy plan

The main number on the **Race** tab compares the amp-hours used so far with the plan:

1. Target for a race: **20 Ah**.
2. Reference race (1 Dec 2025, eChook app CSV): **33 complete laps**, counted from GPS.
3. Ah per lap = 20 ÷ 33 = **0.6061 Ah**.
4. Average lap = **149.070 s** (149 070 ms), including the two pit stops.
5. Ah per second = 0.6061 ÷ 149.070 = **0.0040656 Ah/s** = 4.0656 × 10⁻⁶ Ah/ms
   (the same as a steady 14.64 A). The plan covers 33 × 149.070 s = 81 min 59 s.
6. The ideal at any moment is that rate × the time since the race started.
   The dashboard shows **actual − ideal** as **+x Ah** or **−x Ah**:
   - **+** means more was used than planned: **SLOW DOWN**.
   - **−** means less was used than planned: **SPEED UP**.
   - Within ± the band (0.2 Ah by default): **ON PACE**.

The **Hold for the rest** figure is the steady current that would use exactly the rest of the
20 Ah in the time that's left. In the 1 Dec race the team was within 0.05 Ah of this plan for
the first 30 minutes.

All of these values can be changed in **Settings**. **Data & replay → Use as pacing reference**
redoes the calculation from any race log.

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
