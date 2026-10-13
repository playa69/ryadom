/**
 * Two 200 ms frames of a synthetic voice (`voice()` in tts-decoder.test.ts) as the gateway encodes them:
 * libopus through @evan/opus (WASM), 24 kHz mono, VOIP, 24 kbit/s, complexity 5; each body is ten
 * packets of 20 ms, every one prefixed with its length (uint16 big-endian). Made once by a script with
 * the settings of services/api/src/dialogs/opus-worker.ts, so the client is tested against what the
 * server really sends.
 */
export const OPUS_FRAME_BODIES = [
  [
    'AEFogrSRAz7NrLaRyzU2DnOHAN4rTPKHsKaiXFQot+gP+Gjm+dG+gTtaWKxtRg72jB9+csCKY66FzDEFIKRJvelyWgBPaKSJYWMW',
    '7hcfgV7FEGVPqys5YYnya/rNURmklZ2y3fqFYeLWTbljeSGO5tPA7HOCSA0t8n22WdCXFyuHfo+5stW/YNdEJ/DhAmlpO0I2wQBH',
    'aJ7jsEQ6pwHa51FZwS+4ILoerWQmegfDtEvO5C4iXgLDJUQ3ok/IS41BG3bDB/dLBSGCXFi4bACq4d53GXOAt6KIUSFTpBYAOGif',
    '+bl6PoBK18pdFyLZkhETJycBwCVB5n+95YI5Avg8tV8IWmY2ieNCuiZ+GBHHAJRzhb4msn89ADdon9tdSQfS9xQeilfR6pMM0Sbf',
    'suScWlB3Adsq9yOdxS4egED3hXEfyL4wNQ/5AcIeF6N62DjXADJonrFXEQT/5FoJydpC5nwo5M8v9iqEfV/9bm5wD5ksE5wIEUE8',
    'GiQ6qdH7W4BxMFphIQA0aJx/wKXbY83Xf6gzcC0PDf9QF9Ub38xrNx4QO4ilMi0r3CtLdJkN8Ckb1PqU3Uu9llfVjAAzaJvxXAn2',
    '+4fv3yOzoWu5saURiB1iJgOFTBojNS8MCz+XMKMx7dZhOwqzc7mizspuykVFADRomZgkHFL87drG9av415nyeoyN/3N546prsudf',
    'FspZwtvZeI1uO3nMzUpTphG1WBWAv6FJADdoA/gGyvc1KtkAXUM7X+877QtVNEp8uhFx73Ft88mVliny3FTgpj8LvShKbEQOdL33',
    'FvfosLEZ',
  ].join(''),
  [
    'ADRomQDGgzq03QaYEJXPtgj8qBCNsFowAdzPOGfdsGgfAoAaXFAJ6D/85pTOs2wOib/jNzKSAFBomermmBjGe60z4mIfxW2zoQ1f',
    'U8K6/Wy96cLLgfhFRTK8Lpqjs3Say17To3JKPVg9xIetkFNv6wKNemb/SRatFwlkEyUPZbYgf8RvCMTbRwBCaJvKG1qoJWoO8j9Z',
    'qtBkxApjvkHBj7X7PqUsQob9Rw9ZHMiHMtgXoFCaVFUTpLAbLNTZPCxk3q9h0bcPBkpHSNXOAEtonJwXwEBFyr7txvAHhWiUPkip',
    'n0IXsVXKJZbnJADLjLCA6XByQF4++PnYO07pMZSlKqfaI7yAQiLUBbJKpc1l3oLAuxewogKzxc0ATWidz95z8vwuSQ0yVnllaV4h',
    '8rXgCz2r+CNEq8GcytgD1e35Sxaok8aow1DBDQvnrSsff7y55UAT08u/VhC1/UHOX/lSCva0/mlmDI4DADxon/mai0hjsG4RvNn6',
    '4kfhGkopZiZvEUEz08zv3ISQ+OzwpbgACX7CfnR9OgQiHjrhwIfgUWhrOl+vb6AAOGif+aX8BjlBQh92Bx0r0KqHWbvS4MWmDFZl',
    '2W4LdbhMadW1Dhfr4KI5YM4LITYtj3xvgNXub1zMADZon/mN3RCKBWR2mXSckOE2crU5nfuMRmzg47OxiRlIlGSFFhDtkAIP8hPu',
    'jEWGDh9clu7sqJgAN2idK7kbPS3vHXZbI4dDtvV5kESMTZdaVK6x9+vsGrIjqLnsolioWtdUwgobw4l531elFSNcAQ4ANGicBOQ9',
    'BVWb+V256nf7xjibZ1LLGgb6xQYtsXIFMxUgKFx4WkaPYLrDEULXAvfQ8xmrdEU=',
  ].join(''),
]
