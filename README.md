# expo start takes a port another process holds (Windows)

On Windows, `npx expo start --port 8081` starts Metro on port 8081 while another process already listens on 8081 at `127.0.0.1` or `0.0.0.0`. A client that dials `127.0.0.1:8081` then reaches the other process, not Metro.

```sh
npm install
node repro.mjs
```

`repro.mjs` holds port 8081 on `127.0.0.1`, then on `0.0.0.0`, then on `::`, runs `expo start --port 8081` with `CI=1` beside each holder, and asks both loopback addresses for `/status`. It exits 1 while Expo starts Metro on the held port, 0 once Expo refuses the port or moves to another, and 2 when a step fails first.
