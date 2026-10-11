# Claudeville

*A little town where your Claudes live and work.*

A cozy 3D office where your Claude Code agents come to life. Every Claude Code session is an orange-hoodie **Claude** who walks to a desk and codes while you work. Every subagent walks in through the door, takes a desk, works on its own task, celebrates and leaves when done. Monitors show what each agent is doing: code for edits, a terminal for shell commands, a file tree for searches, a browser for web lookups.

## Run it

Double-click the **Claudeville** shortcut on your desktop (or **Start Claudeville.bat** in this folder). It starts the office if needed and opens it in your browser. Or from a terminal:

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5199. Press **Demo** to watch a scripted run without Claude.

## Connect Claude Code

```bash
npm run hooks:install
```

This adds async hooks to `~/.claude/settings.json` (a backup is written next to it). New Claude Code sessions pick them up automatically. The hooks only forward short labels such as tool names, file names and the first words of a prompt, never file contents, and they do nothing when the office is not running.

Remove them with:

```bash
npm run hooks:uninstall
```

## How it maps

| Claude Code event | In the office |
| --- | --- |
| Session start | A Claude walks in and relaxes in the lounge |
| Prompt submitted | Claude walks to a desk and starts thinking |
| Tool call | Pose, monitor and speech bubble change (typing, reading, terminal, searching, browsing) |
| Agent / Task tool, SubagentStart | A new character enters through the door and takes a desk |
| SubagentStop | The subagent celebrates and walks out |
| Notification | The character raises a hand with an alert bubble |
| Stop | Claude stretches or celebrates, then goes back to the couch |
| Session end | Claude goes home |

## Tease your agents

Pick a tool from the bar at the bottom, or press keys 1 to 0.

| Tool | What happens |
| --- | --- |
| 👆 Hand | Click to poke, click fast to tickle, drag to pick an agent up and drop it |
| 🖐️ Slap | A slap across the face: head snaps, a hand goes to the cheek |
| 🤚 Smack | A smack on the back of the head: they rub it and glare |
| 🗞️ Paper ball | Bonk! The agent rubs its head and glares at you |
| 💦 Water | Hold to squirt. They shiver and protect the keyboard |
| ⏻ Monitor | Switch their screen off. Panic, tapping, then relief |
| ☕ Mug | Steal their coffee. They look for it, then glare |
| 🌀 Spin | Spin their chair (right-click works too). Spin twice and they get dizzy |
| 🪑 Chair | Pull the chair away. They fall on their butt, then hop back up |
| 🦆 Duck | Throw a rubber duck. Everyone loves the duck, and it calms them down |

Annoy one agent too much and it throws a paper ball back at your screen. Teasing is purely cosmetic: agents always go back to exactly what their live session is doing.

The agents also have a life of their own: they scratch their heads, sip coffee, swivel in their chairs, lean back during long commands, facepalm when a tool fails, get a light bulb moment after thinking, doze on the couch, and celebrate finished work with a jump, a dance or a spin.

## Walk around as yourself

Press an arrow key (or the **🚶 Walk** button) and your own character, in an amber hoodie with a mint backpack, walks in through the door.

| Key | Action |
| --- | --- |
| W / ↑, S / ↓ | Walk forward and back |
| A / D | Sidestep |
| ← / → | Turn |
| Shift | Run |
| Space | Jump |
| E | Wave, or high-five an agent standing next to you |
| V | Third person → first person → overview |
| M | Music on or off |

In third person, drag to look around and scroll to zoom. In first person, click to capture the mouse, aim the tease tools with the crosshair, and press Esc to let go. Agents look at you, wave when you arrive, ask for high fives when they celebrate, and get grumpy if you hover behind their chair.

## Sound

Everything is synthesized in the browser with 3D positional audio, so you hear each sound from where it happens: footsteps on wood and rug, keyboards clacking at busy desks, little babbling voices when agents talk, the door, the coffee machine, birds outside, celebrations, and a gentle lo-fi soundtrack. Sound starts on your first click or key press. Use 🔊 to mute and 🎵 (or M) for the music.

## The manager desk

Walk up to the big desk at the front and press **E** to sit in the boss chair, or click **🗂️ Dispatch** from anywhere. Pick a model, a project folder and what the agent may do (edit files, or edit files and run commands), write the task and ring the bell. A new agent walks in, takes the task, works on it for real at a free desk (a  run in that folder), then comes back to your desk to report and leaves. The task list shows live status, a Stop button and the final report.

Models your API key cannot use are crossed out automatically after the first refusal; **Default** always uses the model your Claude Code is set to.

## Your character and the team

The first time you step in you pick a male or female character and a name. Change it any time with **👤**. Every agent gets an Iranian first name with its model next to it, for example *Kourosh · Opus 5.5*, read from its session transcript.

## Chat with your agents

Click 💬 next to any agent in the session list, or walk up to an agent and press **T**. Ask anything, in English or Persian: what it is working on, why a command failed, what is next. The answer comes from a short read-only Claude run that sees the agent's recent actions and the end of its real session transcript, and it may read project files but never changes anything. While you wait, the agent turns to you and thinks with a hand on its chin, then talks with its hands and a little voice. Press Esc to close the chat.

## Controls

Drag to orbit, scroll to zoom, click a name tag or a session row to follow that agent. The speaker button turns on keyboard clacks and chimes.

## Files

- `server/bridge.ts` receives hook events and streams them to the page.
- `hooks/relay.mjs` is the hook command that forwards events.
- `src/director.ts` turns events into character commands.
- `src/office.ts`, `src/agent.ts`, `src/pose.ts` and `src/character.ts` handle desks, movement, animation and the characters.
- `src/world.ts` and `src/screen.ts` build the office and the live monitors.

