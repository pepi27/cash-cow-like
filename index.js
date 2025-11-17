import { Application, Assets, BitmapText, Container, SplitBitmapText, Graphics } from 'pixi.js';
import { Grid } from './Grid.js';

(async () => {
    // Create a new application
    const app = new Application();

    globalThis.__PIXI_APP__ = app;

    // Initialize the application
    // use a darker neutral background to match the new cell color palette
    await app.init({ background: '#0b1220', resizeTo: window });

    // Append the application canvas to the document body
    document.body.appendChild(app.canvas);

    await Assets.load('https://pixijs.com/assets/bitmap-font/desyrel.xml');

    const scene = new Container();
    scene.position.set(app.screen.width / 2, app.screen.height / 2);
    scene.label = 'scene';
    app.stage.addChild(scene);

    const grid = new Grid(8, 8);

    scene.addChild(grid);

    // Score HUD (fixed to screen)
    const hud = new BitmapText('Score: 0', { fontName: 'Desyrel', fontSize: 28, tint: 0xffffff });
    hud.x = 16;
    hud.y = 16;
    hud.zIndex = 1000;
    app.stage.addChild(hud);

    // update HUD every frame
    app.ticker.add(() => {
        try {
            hud.text = `Score: ${grid.score}`;
            hud.updateTransform();
        } catch (e) {}
    });

    // keep scene centered and allow grid to react to size changes
    const onResize = () => {
        // app.screen is kept updated because app.init({ resizeTo: window }) is used
        scene.position.set(app.screen.width / 2, app.screen.height / 2);

        // keep HUD pinned to top-left
        hud.x = 16;
        hud.y = 16;

        // If Grid exposes a resize method, call it. Otherwise try a safe fallback scale.
        if (typeof grid.resize === 'function') {
            grid.resize(app.screen.width, app.screen.height);
        } else if (grid.width != null && grid.height != null) {
            const pad = 40;
            const maxW = Math.max(1, app.screen.width - pad * 2);
            const maxH = Math.max(1, app.screen.height - pad * 2);
            const scale = Math.min(maxW / grid.width, maxH / grid.height, 1);
            grid.scale.set(scale, scale);
        }
    };

    // Initial layout and listen for window resize events
    onResize();
    window.addEventListener('resize', onResize);

    // cleanup listener on unload
    window.addEventListener('beforeunload', () => window.removeEventListener('resize', onResize));
    //     x: 150,
    //     alpha: 0,
    //     duration: 0.7,
    //     ease: 'power4',
    //     stagger: 0.04,
    //     repeat: -1,
    //     yoyo: true,
    // });
})();
