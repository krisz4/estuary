# How it was built

> **Historical.** This is the original author's write-up of how the **helpdesk ticketing** code challenge was planned and built with AI agents, before the project became Estuary. It lived in the README until the project was open-sourced, and it's kept here unedited. The plan and log it mentions are [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) and [BUILD_LOG.md](./BUILD_LOG.md).

**1. Plan architecture**

- I choose to create a separate nodejs app and react app instead of a nextjs solution. It was closer to the task description. To make development and sharing easier I choose to put these two apps into one monorepo. Similarly to make it easier to share and run the project I went with SQLite for db.
- All the request and response shapes live in `packages/contracts` as zod schemas, and both apps get their types from there. The OpenAPI spec is generated from the same schemas. This is what kept the API and the web app in sync, they were built in different stages by different agent sessions and never drifted apart.
- Using AI I created the plan for architecture and set up AGENTS.md and CLAUDE.md files. I used a similar set of instructions and structure as I do with my own projects. That also means a routing table for agents in `docs/AGENTS.md`, one doc per screen and per feature, and scoped subagents in `.claude/agents/`. The implementation might be slightly more serious than what this test expects but it's closer to how I work on a real project.

**2. I created and refined an implementation plan with AI**

It ended up as 16 stages in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md), each one with a pass/fail gate written before the stage ran.

**3. Building the application**

- I gave the following prompt to AI: Build the docs/engineering/IMPLEMENTATION_PLAN.md in the following way: You are an orchestrator managing the the build. Each step of the plan has to be run in a subagent in sequence. Once sub agent finished. A code review has to be done on it. Any remaining work or deferred work has to be documented and if resolvable use any source needed including web search, and finding reference of existing products. Once everything finished and code review findings fixed too commit the changes. After commit start a new subagent with the next step repeat the previously described steps until all steps finished. Consider the performance as well and improvement possibilities and keep track of them in a doc. Don't do them in parallel each step after the next
- The decision for no parallel agents are just for easier tracking and easier continuation in case I run out of session token window
- The prompt creates a multi step flow that builds, reviews and documents feature than commits it. There is also a BUILD_LOG.md file that keeps track of progress and any notes made by the ai. It also keeps track of performance improvement possibilities that were not implemented
- The git history is one commit per stage.
- The thing I like most about how this went is that every stage had to prove its own tests can actually fail. A gate means nothing if the tests behind it pass no matter what, so each stage broke the implementation on purpose and checked that a named test fires. Every stage from 6 onward found at least one test that could not fail. It also caught real bugs, not just weak tests. Stage 7 found `?q=%` returning the whole table, and stage 11 found three UI defects just by looking at screenshots that every test had passed through.

**4. Reviewing BUILD_LOG**

- Decided on which items are worth or needed to be implemented from the deferred items and optimalization suggestions
- The ones I didn't take are written down with a reason and a trigger for when to revisit, so they are decisions and not things that got forgotten. The `commentCount` join, the wildcard search path and its bind parameter limit, and turning off vitest per file isolation, which I remeasured and dropped because the number that made it look slow turned out to be noise.

**5. Manual QA and fixups**

- UI changes: instead of just a list view I wanted a drag and drop columns for the the different states
- Selected view didn't persist on navigation. Introduced state with zustand. I prefer to use it over directly accessing local storage. The rule I settled on is that anything a shared link should reproduce stays in the URL, the store is only for per machine preference.
- Added some optimalizations. The main one is the React Compiler. One component opts out, `CommentComposer`, because it needs `register()` to run again after `reset()` to clear the textarea and the compiler has no way to see that. The reason is written in the file.
