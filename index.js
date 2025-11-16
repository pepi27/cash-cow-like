import { Application, Assets, BitmapText, Container, SplitBitmapText, Graphics } from 'pixi.js';
import { gsap } from 'gsap';
import { SquareWithText } from './SquareWithText.js';
import { Grid } from './Grid.js';

(async () => {
    // Create a new application
    const app = new Application();

    globalThis.__PIXI_APP__ = app;

    // Initialize the application
    await app.init({ background: '#1099bb', resizeTo: window });

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

    // gsap.from(splitText.chars, {
    //     x: 150,
    //     alpha: 0,
    //     duration: 0.7,
    //     ease: 'power4',
    //     stagger: 0.04,
    //     repeat: -1,
    //     yoyo: true,
    // });
})();
