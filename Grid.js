import { Container, Graphics } from 'pixi.js';
import { SquareWithText } from './SquareWithText.js';
import { gsap } from 'gsap';

export class Grid extends Container {
    /**
     * Create a grid of SquareWithText instances.
     * options:
     *  - squareSize (number)
     *  - gap (number)
     *  - center (boolean) center the whole grid on (0,0)
     *  - textGenerator (fn(row,col) -> string)
     *  - squareOptions (object) options passed to SquareWithText
     */
    constructor(rows = 8, cols = 8, options = {}) {
        super();
        const {
            squareSize = 64,
            gap = 4,
            center = true,
            textGenerator = (r, c) => `${r},${c}`,
            squareOptions = {},
            autoMerge = false,
            values = [1, 5, 10, 25, 50, 100],
            weights = [0.35, 0.18, 0.12, 0.06, 0.03, 0.01],
        } = options;

        this.rows = rows;
        this.cols = cols;
        this.squareSize = squareSize;
        this.gap = gap;

        // use configured values & weights
        this.values = values;
        // normalize weights to length of values; if provided shorter/longer, normalize accordingly
        let normalizedWeights =
            weights && weights.length === values.length
                ? weights.slice()
                : (() => {
                      // if weights length mismatches, create simple decreasing weights
                      const w = new Array(values.length).fill(0).map((_, i) => values.length - i);
                      return w;
                  })();
        // normalize to sum 1
        const sumW = normalizedWeights.reduce((a, b) => a + b, 0) || 1;
        normalizedWeights = normalizedWeights.map((w) => w / sumW);
        this.weights = normalizedWeights;

        // helper: pick weighted random from array
        this._pickWeighted = (arr, w) => {
            if (!arr || arr.length === 0) return null;
            if (!w || w.length !== arr.length) return arr[Math.floor(Math.random() * arr.length)];
            const r = Math.random();
            let acc = 0;
            for (let i = 0; i < w.length; i++) {
                acc += w[i];
                if (r <= acc) return arr[i];
            }
            return arr[arr.length - 1];
        };

        // compute totals before placing cells so layout math can use them
        const totalWidth = cols * squareSize + (cols - 1) * gap;
        const totalHeight = rows * squareSize + (rows - 1) * gap;

        this._cells = Array.from({ length: rows }, () => Array(cols).fill(null));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                // pick initial cell value with weights
                const text = this._pickWeighted(this.values, this.weights);
                const cell = new SquareWithText(text, {
                    ...squareOptions,
                    size: squareSize,
                    fontSize: 32,
                });

                const x = c * (squareSize + gap) + squareSize / 2;
                const y = r * (squareSize + gap) + squareSize / 2;

                if (center) {
                    cell.x = x - totalWidth / 2;
                    cell.y = y - totalHeight / 2;
                } else {
                    cell.x = x;
                    cell.y = y;
                }

                this.addChild(cell);
                this._cells[r][c] = cell;
            }
        }

        // store totals for positioning
        this.totalWidth = totalWidth;
        this.totalHeight = totalHeight;

        // path graphics for selection visuals
        this.pathGraphics = new Graphics();
        this.addChild(this.pathGraphics);

        // gameplay values and interaction state
        this.minCollectLen = 2;
        this._selection = [];
        this._isPointerDown = false;
        this.autoMerge = autoMerge;
        // score
        this.score = 0;

        // enable interaction
        this.interactive = true;
        this.on('pointerdown', (e) => this._onPointerDown(e));
        this.on('pointermove', (e) => this._onPointerMove(e));
        this.on('pointerup', () => this._onPointerUp());
        this.on('pointerupoutside', () => this._onPointerUp());

        // tap to collect gold
        this.on('pointertap', (e) => this._onTap(e));
    }

    getCell(row, col) {
        if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return null;
        return this._cells[row][col];
    }

    setTextAt(row, col, text) {
        const cell = this.getCell(row, col);
        if (cell) cell.setText(text);
    }

    forEachCell(cb) {
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                cb(this._cells[r][c], r, c);
            }
        }
    }

    setAllText(fn) {
        this.forEachCell((cell, r, c) => cell.setText(fn(r, c)));
    }

    // robust point -> cell detection by bounding box
    getCellAtPoint(globalX, globalY) {
        const local = this.toLocal({ x: globalX, y: globalY });
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = this._cells[r][c];
                const half = this.squareSize / 2;
                const dx = local.x - cell.x;
                const dy = local.y - cell.y;
                if (Math.abs(dx) <= half && Math.abs(dy) <= half) return { r, c, cell };
            }
        }
        return null;
    }

    _isAdjacent(r1, c1, r2, c2) {
        return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
    }

    _onPointerDown(e) {
        const global = e.data.global;
        const hit = this.getCellAtPoint(global.x, global.y);
        if (!hit) return;
        this._isPointerDown = true;
        this._selection = [{ r: hit.r, c: hit.c, cell: hit.cell }];
        this._highlightCell(hit.cell, true);
        this._updatePathGraphics();
    }

    _onPointerMove(e) {
        if (!this._isPointerDown) return;
        const global = e.data.global;
        const hit = this.getCellAtPoint(global.x, global.y);
        if (!hit) return;
        this._tryExtendPath(hit.r, hit.c, hit.cell);
        this._updatePathGraphics();
    }

    async _onPointerUp() {
        if (!this._isPointerDown) return;
        this._isPointerDown = false;
        const sel = this._selection;
        if (sel.length >= this.minCollectLen) {
            // compute sum of selected cell values
            const sum = sel.reduce((acc, s) => acc + (Number(s.cell.value) || 0), 0);
            const target = sel[sel.length - 1];

            // if sum is not one of allowed values, cancel merge with a small shake and un-highlight
            if (!this.values.includes(sum)) {
                // small shake on target
                const origX = target.cell.x;
                gsap.to(target.cell, {
                    x: origX + 8,
                    duration: 0.04,
                    yoyo: true,
                    repeat: 6,
                    ease: 'sine.inOut',
                    onComplete: () => {
                        target.cell.x = origX;
                    },
                });
                // un-highlight selection
                sel.forEach((s) => this._highlightCell(s.cell, false));
                this._selection = [];
                this._updatePathGraphics();
                return;
            }

            // animate collected cells except target
            sel.forEach((s) => {
                if (s === target) return;
                gsap.to(s.cell, { alpha: 0, duration: 0.18 });
            });

            // upgrade target visually to the summed value
            // pop then settle at scale 1
            gsap.fromTo(
                target.cell.scale,
                { x: 0.6, y: 0.6 },
                {
                    x: 1.2,
                    y: 1.2,
                    duration: 0.18,
                    ease: 'power2.out',
                    onComplete: () => {
                        gsap.to(target.cell.scale, {
                            x: 1,
                            y: 1,
                            duration: 0.12,
                            ease: 'power2.in',
                        });
                    },
                }
            );
            target.cell.setValue(Number(sum));

            // after fade animation, clear others and collapse
            await new Promise((resolve) => setTimeout(resolve, 220));
            // clear non-target selected cells
            for (let s of sel) {
                if (s === target) continue;
                s.cell.setValue(null);
                s.cell.alpha = 1;
            }

            await this._collapseColumn();
            if (this.autoMerge) await this._autoMergeLoop();
        } else {
            // un-highlight
            sel.forEach((s) => this._highlightCell(s.cell, false));
        }
        this._selection = [];
        this._updatePathGraphics();
    }

    _updatePathGraphics() {
        const g = this.pathGraphics;
        g.clear();
        if (!this._selection || this._selection.length === 0) return;
        g.lineStyle(6, 0xffffff, 0.18);
        // draw circles and connecting lines
        const points = this._selection.map((s) => ({ x: s.cell.x, y: s.cell.y }));
        g.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            g.lineTo(points[i].x, points[i].y);
        }
        // draw end circles
        for (let p of points) {
            g.beginFill(0xffffff, 0.06);
            g.drawCircle(p.x, p.y, this.squareSize * 0.36);
            g.endFill();
        }
    }

    _tryExtendPath(r, c, cell) {
        const sel = this._selection;
        if (!sel || sel.length === 0) return;
        const last = sel[sel.length - 1];
        // backtrack (allow undoing the last selection)
        if (sel.length >= 2) {
            const prev = sel[sel.length - 2];
            if (prev.r === r && prev.c === c) {
                this._highlightCell(last.cell, false);
                sel.pop();
                this._updatePathGraphics();
                return;
            }
        }

        // ignore if already in path
        if (sel.some((s) => s.r === r && s.c === c)) return;

        // must match the selected value
        const baseValue = sel[0].cell.value;
        if (cell.value == null || cell.value !== baseValue) return;

        // allow adding if the cell is adjacent to ANY selected cell (not just last)
        const adjacentToAny = sel.some((s) => this._isAdjacent(s.r, s.c, r, c));
        if (!adjacentToAny) return;

        // add
        sel.push({ r, c, cell });
        this._highlightCell(cell, true);
        this._updatePathGraphics();
    }

    _collapseColumn() {
        // animate collapse where existing non-null cells fall to their destination rows
        this.interactive = false;
        const animations = [];

        for (let c = 0; c < this.cols; c++) {
            // gather source cells and values top->bottom
            const srcCells = [];
            const srcVals = [];
            for (let r = 0; r < this.rows; r++) {
                const cell = this._cells[r][c];
                srcCells.push(cell);
                srcVals.push(cell.value == null ? null : Number(cell.value));
            }

            const nonNullVals = srcVals.filter((v) => v != null);
            const emptyCount = this.rows - nonNullVals.length;
            const newVals = Array.from({ length: emptyCount }, () =>
                this._pickWeighted(this.values, this.weights)
            );
            const finalVals = newVals.concat(nonNullVals); // top->bottom final values

            // Map each non-null source (in original top->bottom order) to a destination index: destIndex = emptyCount + i
            let nonNullIndex = 0;
            const usedSourceIndices = [];

            for (let r = 0; r < this.rows; r++) {
                const destCell = this._cells[r][c];
                const targetVal = finalVals[r];

                if (r < emptyCount) {
                    // spawn new falling square from above
                    const spawn = new SquareWithText(targetVal, {
                        size: this.squareSize,
                        fontSize: Math.min(32, this.squareSize / 2),
                    });
                    spawn.x = destCell.x;
                    spawn.y = destCell.y - this.totalHeight - 40 - Math.random() * 80;
                    spawn.alpha = 0;
                    this.addChild(spawn);

                    const prom = new Promise((resolve) => {
                        gsap.to(spawn, {
                            y: destCell.y,
                            alpha: 1,
                            duration: 0.35 + Math.random() * 0.12,
                            ease: 'power2.out',
                            onComplete: () => {
                                destCell.setValue(
                                    Number.isFinite(Number(targetVal))
                                        ? Number(targetVal)
                                        : targetVal
                                );
                                this.removeChild(spawn);
                                resolve();
                            },
                        });
                    });
                    animations.push(prom);
                } else {
                    // assign from next non-null source
                    const valueToPlace = nonNullVals[nonNullIndex++];
                    // find the source index corresponding to this non-null occurrence
                    let foundIdx = -1;
                    let count = 0;
                    for (let s = 0; s < srcVals.length; s++) {
                        if (srcVals[s] != null) {
                            if (count === nonNullIndex - 1) {
                                foundIdx = s;
                                break;
                            }
                            count++;
                        }
                    }
                    const sourceCell = foundIdx >= 0 ? srcCells[foundIdx] : null;

                    if (sourceCell) {
                        // create temp visual at source and animate to dest
                        const temp = new SquareWithText(sourceCell.value, {
                            size: this.squareSize,
                            fontSize: Math.min(32, this.squareSize / 2),
                        });
                        temp.x = sourceCell.x;
                        temp.y = sourceCell.y;
                        this.addChild(temp);

                        // clear source cell immediately
                        sourceCell.setValue(null);

                        const prom = new Promise((resolve) => {
                            gsap.to(temp, {
                                x: destCell.x,
                                y: destCell.y,
                                duration: 0.25 + Math.random() * 0.2,
                                ease: 'power2.inOut',
                                onComplete: () => {
                                    destCell.setValue(
                                        Number.isFinite(Number(valueToPlace))
                                            ? Number(valueToPlace)
                                            : valueToPlace
                                    );
                                    this.removeChild(temp);
                                    resolve();
                                },
                            });
                        });
                        animations.push(prom);
                    } else {
                        // fallback: direct set
                        destCell.setValue(
                            Number.isFinite(Number(valueToPlace))
                                ? Number(valueToPlace)
                                : valueToPlace
                        );
                    }
                }
            }
        }

        return Promise.all(animations).then(() => {
            this.interactive = true;
        });
    }

    // find groups of connected cells with same value (4-way), returns array of groups (each group is array of {r,c})
    _findGroups() {
        const visited = Array.from({ length: this.rows }, () => Array(this.cols).fill(false));
        const groups = [];

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (visited[r][c]) continue;
                const v = this._cells[r][c].value;
                if (v == null) {
                    visited[r][c] = true;
                    continue;
                }
                // BFS
                const q = [[r, c]];
                const group = [];
                visited[r][c] = true;
                while (q.length) {
                    const [cr, cc] = q.shift();
                    group.push({ r: cr, c: cc });
                    const neighbors = [
                        [cr - 1, cc],
                        [cr + 1, cc],
                        [cr, cc - 1],
                        [cr, cc + 1],
                    ];
                    for (let [nr, nc] of neighbors) {
                        if (nr < 0 || nc < 0 || nr >= this.rows || nc >= this.cols) continue;
                        if (visited[nr][nc]) continue;
                        if (this._cells[nr][nc].value === v) {
                            visited[nr][nc] = true;
                            q.push([nr, nc]);
                        }
                    }
                }
                if (group.length > 0) groups.push({ value: v, cells: group });
            }
        }
        return groups;
    }

    // auto-merge loop: find groups >= minCollectLen and apply merge+collapse until none remain
    async _autoMergeLoop() {
        while (true) {
            const groups = this._findGroups().filter((g) => g.cells.length >= this.minCollectLen);
            if (!groups.length) break;
            // process groups sequentially to avoid conflicts
            for (let grp of groups) {
                // pick target as last cell in group
                const last = grp.cells[grp.cells.length - 1];
                const value = grp.value;
                // determine next value by index; if value not found, just use same
                const idx = this.values.findIndex((v) => v === value);
                const nextVal =
                    idx >= 0 ? this.values[Math.min(idx + 1, this.values.length - 1)] : value;

                // animate non-target cells fade
                for (let cellRef of grp.cells) {
                    const cell = this._cells[cellRef.r][cellRef.c];
                    if (cellRef.r === last.r && cellRef.c === last.c) continue;
                    gsap.to(cell, { alpha: 0, duration: 0.18 });
                }

                // upgrade target
                const targetCell = this._cells[last.r][last.c];
                gsap.fromTo(
                    targetCell.scale,
                    { x: 0.6, y: 0.6 },
                    {
                        x: 1.2,
                        y: 1.2,
                        duration: 0.18,
                        ease: 'power2.out',
                        onComplete: () => {
                            gsap.to(targetCell.scale, {
                                x: 1,
                                y: 1,
                                duration: 0.12,
                                ease: 'power2.in',
                            });
                        },
                    }
                );
                targetCell.setValue(Number.isFinite(Number(nextVal)) ? Number(nextVal) : nextVal);

                // after fade, clear others and collapse
                await new Promise((resolve) => setTimeout(resolve, 240));
                for (let cellRef of grp.cells) {
                    if (cellRef.r === last.r && cellRef.c === last.c) continue;
                    const cell = this._cells[cellRef.r][cellRef.c];
                    cell.setValue(null);
                    cell.alpha = 1;
                }

                await this._collapseColumn();
            }
            // loop to detect new groups after collapse
        }
    }

    _onTap(e) {
        const global = e.data.global;
        const hit = this.getCellAtPoint(global.x, global.y);
        if (!hit) return;
        const { r, c, cell } = hit;
        if (cell.value === 500) {
            // collect gold: increment score and clear cell
            this.score += 500;
            // small pop and fade
            gsap.to(cell.scale, { x: 1.3, y: 1.3, duration: 0.12, yoyo: true, repeat: 1 });
            gsap.to(cell, {
                alpha: 0,
                duration: 0.22,
                onComplete: async () => {
                    cell.setValue(null);
                    cell.alpha = 1;
                    // refill/collapse to settle the grid after collection
                    try {
                        await this._collapseColumn();
                    } catch (err) {
                        // ignore
                    }
                },
            });
        }
    }
}
