import { Container, Graphics, BitmapText } from 'pixi.js';

function parseValue(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
}

export class SquareWithText extends Container {
    constructor(text = '', options = {}) {
        super();
        const {
            size = 160,
            fill = 0x333333,
            fontName = 'Desyrel',
            fontSize = 64,
            tint = 0xffffff,
        } = options;

        this._size = size;
        this._defaultFill = fill;
        this._fontName = fontName;
        this._fontSize = fontSize;
        this._tint = tint;

        // background square centered at (0,0)
        this.bg = new Graphics();
        this.bg.beginFill(fill);
        this.bg.drawRect(-size / 2, -size / 2, size, size);
        this.bg.endFill();
        this.addChild(this.bg);

        // bitmap text (requires the bitmap font to be loaded before creating)
        this.bitmap = new BitmapText('', { fontName, fontSize, tint });
        // center the bitmap text within the square
        this.bitmap.pivot.x = 0;
        this.bitmap.pivot.y = 0;
        this.bitmap.x = 0;
        this.bitmap.y = 0;
        this.addChild(this.bitmap);

        // store numeric value
        this.value = null;
        this.setValue(parseValue(text));
    }

    // unified background redraw; if color omitted, choose gold for value 500 or default fill
    _redrawBg(color) {
        const size = this._size;
        const fillColor = color ?? (this.value === 500 ? 0xffd700 : this._defaultFill ?? 0x333333);
        this.bg.clear();
        this.bg.beginFill(fillColor);
        // rounded rect for nicer visuals
        this.bg.drawRoundedRect(-size / 2, -size / 2, size, size, Math.max(6, size * 0.08));
        this.bg.endFill();
    }

    setText(text) {
        if (text === null || text === undefined) {
            this.bitmap.text = '';
            this.value = null;
        } else {
            this.bitmap.text = String(text);
            this.value = parseValue(text);
        }
        // update pivot after changing text
        // bitmap.updateTransform may not immediately update width/height, so use measured width if available
        try {
            this.bitmap.updateTransform();
        } catch (e) {}
        this.bitmap.pivot.x = (this.bitmap.width || 0) / 2;
        this.bitmap.pivot.y = (this.bitmap.height || 0) / 2;

        // redraw background and tint based on value
        if (this.value === 500) {
            this.bitmap.tint = 0x000000;
        } else {
            this.bitmap.tint = this._tint;
        }
        this._redrawBg();
    }

    setValue(val) {
        if (val === null || val === undefined) {
            this.value = null;
            this.setText('');
            this._redrawBg();
            return;
        }
        const n = Number(val);
        this.value = Number.isFinite(n) ? n : null;
        this.setText(this.value != null ? String(this.value) : '');
        this._redrawBg();
    }

    isGold() {
        return this.value === 500;
    }

    setSize(size, fill) {
        this._size = size;
        this._defaultFill = fill ?? this._defaultFill;
        this.bg.clear();
        this._redrawBg();
        this.bg.endFill();
    }
}
