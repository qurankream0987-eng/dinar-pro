# DINAR AI: motion system

## Library decision

`framer-motion` is already a dependency but imported nowhere. The motion needed here is:
- entrances;
- one arc flight;
- one catch;
- a sheet rise.

CSS keyframes and the Web Animations API (already used by the cart flight) cover all of it, on the compositor (`transform` / `opacity`), at zero bundle cost. So no motion library is added or imported.

## Tokens (`AiChat.css`, `:root`)

| Token | Value | Use |
|---|---|---|
| `--motion-micro` | 140ms | hover, press, focus |
| `--motion-message` | 220ms | message entrance |
| `--motion-card` | 280ms | result-card entrance |
| `--motion-drawer` | 300ms | camera sheet, drawers |
| `--motion-cart` | 620ms | product flight |
| `--ease-standard` | `cubic-bezier(.2,.8,.2,1)` | entrances |
| `--ease-exit` | `cubic-bezier(.4,0,1,1)` | exits |
| `--ease-catch` | `cubic-bezier(.34,1.56,.64,1)` | basket catch (slight overshoot) |

## Inventory after this change

| Motion | Trigger | Where |
|---|---|---|
| Message entrance | new message | `.ai-message-in`, 220ms |
| Result cards | a result set appears: one staggered entrance (0 / 45 / 90 / 135 ms), then still | `.ai-result-item`, `dinar-card-enter` |
| Card hover and focus | pointer / keyboard | gold border, 140ms lift |
| Add-to-cart press | tap | scale .94 |
| **Product flight** | **after server confirmation only** | `cart-basket-animation.ts` |
| **Basket catch** | flight end | `.dinar-basket-catch`, 360ms with overshoot |
| Processing symbol | turn pending | breathes (1.6s); spins only while searching, so the two states look different |
| Camera sheet | open | backdrop fade, sheet rise 300ms |
| Mic pulse, history drawer | as before | unchanged |

Product flight detail:
- a quadratic arc sampled into 11 keyframes;
- the apex is above both ends, lift `min(160, 56 + |dx|·0.22)` px;
- the image scales down to the basket size and fades in the last 20%.

## Reduced motion

`prefers-reduced-motion: reduce` turns off:
- the card entrance, the catch and the processing symbol;
- the camera sheet animation (it is only applied under `no-preference`);
- the press scale.

The product flight is skipped as before (event `dinar:cart-flight-skipped {reason:"reduced-motion"}`), and the cart still commits.

## Not done, on purpose

- No fake token streaming: the runtime does not stream tokens.
- No skeletons in the thread.
- No decorative glow loops.
