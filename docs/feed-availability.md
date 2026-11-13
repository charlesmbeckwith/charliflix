# Feed availability check

Checked October 28, 2026 (America/Los_Angeles). These observations can change when providers recover or move. They describe the sources checked, not permanent channel availability.

## Sources supported by Charliflix 0.3.8

| Channels | Feed choices |
| --- | --- |
| ABC, CBS, NBC, FOX | Player 1, Player 2, CDNLiveTV |
| Cartoon Network, Comedy Central, FX, FXX, AMC, CW | Player 1, Player 2 |
| Adult Swim Archive | Public recordings listed by Spelunkr channel 54, on Charliflix's own rotation |

The archive addition was checked November 13, 2026. It uses Spelunkr's public recording manifest and Internet Archive's ranged MP4 playback, rather than an HLS feed. Sampled video was H.264 640×480 with non-silent stereo AAC. Guide entries and scheduled switches follow Charliflix's rotation, which differs from Spelunkr's bump-card and music scheduling. Public availability is not rights clearance. The original network-feed observations below remain dated October 28.

The original site's Players 1, 3 and 7 use the same primary embed. Player 2 uses the alternate already integrated in Charliflix. The three remaining player slots vary by channel, so a Cartoon Network-only test was insufficient to assess the whole lineup.

CDNLiveTV is an additional provider, separate from those broken player-slot checks. Its [documented public free catalog](https://cdnlivetv.tv/) has exact entries for `ABC US`, `CBS US`, `NBC US` and `FOX US`. Their public free players and HLS playlists returned successfully, and media segments passed through the application's TS handling. The similarly named CNBC, NBC Universo, FOX News/Sports and CBS Sports Golazo entries are different channels and were excluded. No matching cable or CW entries were found.

## Remaining original-site options

| Channel | Player 4 | Player 5 | Player 6 |
| --- | --- | --- | --- |
| Cartoon Network | Provider HTTP 502 | Nested player timed out | Provider refused HTTPS |
| Comedy Central | Provider HTTP 404 | Nested player timed out | Provider refused HTTPS |
| FX | Provider HTTP 502 | Browser verification required | Provider refused HTTPS |
| FXX | Business landing page, no player | Same unreachable Kso provider | Provider refused HTTPS |
| AMC | Provider HTTP 502 | Browser verification required | Provider refused HTTPS |
| ABC | Provider HTTP 502 | Browser verification required | Decodable but frozen playlist |
| CBS | Provider HTTP 502 | Custom player returned HTTP 401 | Provider refused HTTPS |
| NBC | Provider HTTP 502 | Nested player timed out | Nested player timed out |
| FOX | Provider HTTP 502 | Nested player timed out | Provider refused HTTPS |
| CW | Provider HTTP 502 | Same unreachable Kso provider | Provider refused HTTPS |

The original site's wrappers were initially reachable and later began timing out. The table records the downstream stage reached during inspection. Same-origin redirects were followed within a finite limit before classifying the Player 4 failures.

ABC Player 6 illustrates why an HTTP 200 response alone is insufficient: it returned valid 720p H.264 and stereo AAC, but the same 25-second commercial playlist remained unchanged across samples 70 seconds apart. Its media sequence and body hash did not advance, and its modification date was four days old. It was not enabled as a healthy live source.

The protected CBS custom player was not used. The added CDNLiveTV feed uses the separate, documented public free catalog entry. No browser-verification challenges were bypassed, and no third-party advertising/player scripts run inside Charliflix.

Additional providers can be added when their correct channel mapping and usable playback format are established. Existing choices remain available manually; each source is tried at most once per automatic tune cycle.
