import { Container, Graphics } from 'pixi.js';
import { SquareWithText } from './SquareWithText.js';
import { gsap } from 'gsap';
import {
    fromEventPattern,
    BehaviorSubject,
    merge,
    forkJoin,
    lastValueFrom,
    Observable,
    Subject,
    of,
} from 'rxjs';
import { map, filter, tap, switchMap, takeUntil, finalize } from 'rxjs/operators';

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
            values = [1, 5, 10, 25, 50, 100, 500],
            weights = [0.36, 0.18, 0.12, 0.06, 0.03, 0.01, 0],
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
        // score (imperative) and observable score stream for external subscribers
        this.score = 0;
        try {
            this.score$ = new BehaviorSubject(this.score);
        } catch (e) {
            this.score$ = null;
        }

        // enable interaction
        this.interactive = true;
        // lifecycle subject used to cancel streams/animations on destroy
        this._destroy$ = new Subject();
        // create RxJS observables from PIXI event emitter hooks so input handling is reactive
        const make$ = (eventName) =>
            fromEventPattern(
                // add
                (h) => this.on(eventName, h),
                // remove
                (h) => this.off(eventName, h)
            );

        // Compose a single drag/selection stream instead of multiple imperative subscribers
        try {
            this._inputSubs = [];

            const pointerDown$ = make$('pointerdown');
            const pointerMove$ = make$('pointermove');
            const pointerUp$ = merge(make$('pointerup'), make$('pointerupoutside'));
            const pointerTap$ = make$('pointertap');

            const dragSub = pointerDown$
                .pipe(
                    map((e) => e.data.global),
                    map((g) => this.getCellAtPoint(g.x, g.y)),
                    filter(Boolean),
                    tap((hit) => {
                        // start selection on pointer down
                        this._isPointerDown = true;
                        this._selection = [{ r: hit.r, c: hit.c, cell: hit.cell }];
                        this._highlightCell(hit.cell, true);
                        this._updatePathGraphics();
                    }),
                    switchMap(() =>
                        pointerMove$.pipe(
                            map((e) => e.data.global),
                            map((g) => this.getCellAtPoint(g.x, g.y)),
                            filter(Boolean),
                            tap((hit) => {
                                this._tryExtendPath(hit.r, hit.c, hit.cell);
                                this._updatePathGraphics();
                            }),
                            takeUntil(pointerUp$),
                            takeUntil(this._destroy$),
                            finalize(() => {
                                // when the drag ends call the existing pointer-up handler
                                try {
                                    this._onPointerUp();
                                } catch (e) {}
                            })
                        )
                    ),
                    takeUntil(this._destroy$)
                )
                .subscribe();

            this._inputSubs.push(dragSub);
            // keep tap subscription separate (currently _onTap is a no-op)
            this._inputSubs.push(
                pointerTap$.pipe(takeUntil(this._destroy$)).subscribe((e) => this._onTap(e))
            );
        } catch (e) {
            // fallback to direct listeners if RxJS subscription fails
            // this.on('pointerdown', (e) => this._onPointerDown(e));
            // this.on('pointermove', (e) => this._onPointerMove(e));
            // this.on('pointerup', () => this._onPointerUp());
            // this.on('pointerupoutside', () => this._onPointerUp());
            // this.on('pointertap', (e) => this._onTap(e));
        }

        // tap to collect gold
        // this.on('pointertap', (e) => this._onTap(e));
    }

    destroy(options) {
        // unsubscribe input subscriptions if any
        try {
            if (this._inputSubs && Array.isArray(this._inputSubs)) {
                this._inputSubs.forEach((s) => {
                    try {
                        s.unsubscribe && s.unsubscribe();
                    } catch (e) {}
                });
                this._inputSubs = null;
            }
        } catch (e) {}
        // signal and complete destroy subject to cancel streams/tweens
        try {
            if (this._destroy$) {
                try {
                    this._destroy$.next();
                } catch (e) {}
                try {
                    this._destroy$.complete();
                } catch (e) {}
                this._destroy$ = null;
            }
        } catch (e) {}
        // call parent destroy if available
        try {
            if (super.destroy) super.destroy(options);
        } catch (e) {}
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

    // prefer inner content scale if the SquareWithText exposes it
    _getScaleTarget(cell) {
        if (!cell) return { x: 1, y: 1 };
        return cell.content && cell.content.scale ? cell.content.scale : cell.scale;
    }

    // Helper: wrap gsap.to as an Observable that completes when the tween completes
    _tweenTo$(target, vars) {
        return new Observable((subscriber) => {
            const cfg = Object.assign({}, vars);
            // override onComplete to notify the observable
            const userOnComplete = cfg.onComplete;
            cfg.onComplete = function () {
                try {
                    if (typeof userOnComplete === 'function') userOnComplete.apply(this, arguments);
                } catch (e) {}
                try {
                    subscriber.next(true);
                } catch (e) {}
                try {
                    subscriber.complete();
                } catch (e) {}
            };

            const tween = gsap.to(target, cfg);

            // teardown: kill the tween if unsubscribed
            return () => {
                try {
                    tween && tween.kill && tween.kill();
                } catch (e) {}
            };
        });
    }

    _tweenFromTo$(target, fromVars, toVars) {
        return new Observable((subscriber) => {
            const cfg = Object.assign({}, toVars);
            const userOnComplete = cfg.onComplete;
            cfg.onComplete = function () {
                try {
                    if (typeof userOnComplete === 'function') userOnComplete.apply(this, arguments);
                } catch (e) {}
                try {
                    subscriber.next(true);
                } catch (e) {}
                try {
                    subscriber.complete();
                } catch (e) {}
            };

            // set initial properties if provided
            try {
                if (fromVars) gsap.set(target, fromVars);
            } catch (e) {}

            const tween = gsap.to(target, cfg);

            return () => {
                try {
                    tween && tween.kill && tween.kill();
                } catch (e) {}
            };
        });
    }

    // show / hide a lightweight highlight overlay on a cell
    _highlightCell(cell, on) {
        if (!cell) return;
        try {
            if (on) {
                if (cell._hl) return; // already highlighted
                const g = new Graphics();
                const size =
                    typeof cell._size === 'number' && cell._size > 0 ? cell._size : this.squareSize;
                g.beginFill(0xffffff, 0.06);
                g.drawRoundedRect(-size / 2, -size / 2, size, size, Math.max(6, size * 0.08));
                g.endFill();
                cell.addChild(g);
                cell._hl = g;
            } else {
                if (cell._hl) {
                    try {
                        cell.removeChild(cell._hl);
                        cell._hl.destroy();
                    } catch (e) {}
                    cell._hl = null;
                }
            }
        } catch (e) {}
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

    _onPointerUp() {
        if (!this._isPointerDown) return;
        this._isPointerDown = false;
        const sel = this._selection;
        if (sel.length >= this.minCollectLen) {
            // compute sum of selected cell values
            const sum = sel.reduce((acc, s) => acc + (Number(s.cell.value) || 0), 0);
            const target = sel[sel.length - 1];

            // determine resulting merged value. By default the sum must be an allowed value, but
            // special-case: 5 + 10 (sum 15) should produce 25.
            let resultValue = null;
            if (this.values.includes(sum)) {
                resultValue = sum;
            } else {
                const has5 = sel.some((s) => Number(s.cell.value) === 5);
                const has10 = sel.some((s) => Number(s.cell.value) === 10);
                if (sum === 25 && has5 && has10) {
                    resultValue = 25;
                }
            }

            // if resultValue is still null, cancel merge with a small shake and un-highlight
            if (resultValue == null) {
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
            // add resulting merged value to the score
            try {
                this.score = (Number(this.score) || 0) + Number(resultValue);
            } catch (e) {}
            try {
                if (this.score$ && typeof this.score$.next === 'function')
                    this.score$.next(this.score);
            } catch (e) {}
            target.cell.setValue(
                Number.isFinite(Number(resultValue)) ? Number(resultValue) : resultValue
            );

            // after fade animation, clear others and collapse
            setTimeout(() => {
                // clear non-target selected cells and remove their highlights immediately
                for (let s of sel) {
                    if (s === target) continue;
                    try {
                        s.cell.setValue(null);
                        s.cell.alpha = 1;
                        this._highlightCell(s.cell, false);
                    } catch (e) {}
                }

                // keep only the target selected so the path clears; update visuals before collapse
                this._selection = [target];
                this._updatePathGraphics();

                // call collapse (returns Observable). Subscribe so we can clear selection after completion.
                try {
                    const collapse$ = this._collapseColumn();
                    if (collapse$ && typeof collapse$.subscribe === 'function') {
                        collapse$.subscribe({
                            next: () => {},
                            error: () => {
                                try {
                                    this._selection = [];
                                    this._updatePathGraphics();
                                } catch (e) {}
                            },
                            complete: () => {
                                try {
                                    this._selection = [];
                                    this._updatePathGraphics();
                                } catch (e) {}
                            },
                        });
                    } else if (collapse$ && typeof collapse$.then === 'function') {
                        // in case it returns a Promise
                        collapse$.then(
                            () => {
                                try {
                                    this._selection = [];
                                    this._updatePathGraphics();
                                } catch (e) {}
                            },
                            () => {
                                try {
                                    this._selection = [];
                                    this._updatePathGraphics();
                                } catch (e) {}
                            }
                        );
                    } else {
                        // fallback immediate cleanup
                        try {
                            this._selection = [];
                            this._updatePathGraphics();
                        } catch (e) {}
                    }
                } catch (e) {
                    try {
                        this._selection = [];
                        this._updatePathGraphics();
                    } catch (e) {}
                }
            }, 220);
        } else {
            // un-highlight
            sel.forEach((s) => this._highlightCell(s.cell, false));
            this._selection = [];
            this._updatePathGraphics();
        }
    }

    _updatePathGraphics() {
        const g = this.pathGraphics;
        // always clear first
        g.clear();
        if (!this._selection || this._selection.length < 2) {
            // nothing to draw for 0 or 1 selection entries
            return;
        }
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

        // must match the selected value (allow mixing 5s and 10s)
        const baseValue = Number(sel[0].cell.value);
        const candidateValue = Number(cell.value);
        if (cell.value == null) return;
        // allow either same-value selections OR mixing 5 and 10 together
        const allowMix5and10 =
            (baseValue === 5 || baseValue === 10) &&
            (candidateValue === 5 || candidateValue === 10);
        if (!(candidateValue === baseValue || allowMix5and10)) return;

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
        const animations$ = [];

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

            let nonNullIndex = 0;

            for (let r = 0; r < this.rows; r++) {
                const destCell = this._cells[r][c];
                const targetVal = finalVals[r];

                if (r < emptyCount) {
                    // spawn new falling square from above
                    try {
                        destCell.visible = false;
                    } catch (e) {}
                    const spawn = new SquareWithText(targetVal, {
                        size: this.squareSize,
                        fontSize: Math.min(32, this.squareSize / 2),
                    });
                    spawn.x = destCell.x;
                    spawn.y = destCell.y - this.totalHeight - 40 - Math.random() * 80;
                    spawn.alpha = 0;
                    this.addChild(spawn);

                    const dur = 0.35 + Math.random() * 0.12;
                    const obs$ = this._tweenTo$(spawn, {
                        y: destCell.y,
                        alpha: 1,
                        duration: dur,
                        ease: 'power2.out',
                    })
                        .pipe(
                            // perform side-effects when tween completes
                            tap(() => {
                                destCell.setValue(
                                    Number.isFinite(Number(targetVal))
                                        ? Number(targetVal)
                                        : targetVal
                                );
                                try {
                                    destCell.visible = true;
                                } catch (e) {}
                                this.removeChild(spawn);
                            })
                        )
                        .pipe(takeUntil(this._destroy$));
                    animations$.push(obs$);
                } else {
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
                        // animate existing cell drop to target
                        const temp = new SquareWithText(valueToPlace, {
                            size: this.squareSize,
                            fontSize: Math.min(32, this.squareSize / 2),
                        });
                        temp.x = sourceCell.x;
                        temp.y = sourceCell.y;
                        this.addChild(temp);

                        // smooth drop to destination
                        const dur = 0.24 + Math.random() * 0.08;
                        const obs$ = this._tweenTo$(temp, {
                            x: destCell.x,
                            y: destCell.y,
                            duration: dur,
                            ease: 'power2.inOut',
                        })
                            .pipe(
                                tap(() => {
                                    destCell.setValue(
                                        Number.isFinite(Number(valueToPlace))
                                            ? Number(valueToPlace)
                                            : valueToPlace
                                    );
                                    try {
                                        destCell.visible = true;
                                    } catch (e) {}
                                    this.removeChild(temp);
                                })
                            )
                            .pipe(takeUntil(this._destroy$));
                        animations$.push(obs$);
                    }
                }
            }
        }

        // create cleanup routine
        const cleanup = () => {
            try {
                if (this.pathGraphics) this.pathGraphics.clear();
                if (this._selection && this._selection.length) {
                    this._selection.forEach((s) => {
                        try {
                            this._highlightCell(s.cell, false);
                        } catch (e) {}
                    });
                }
                for (let rr = 0; rr < this.rows; rr++) {
                    for (let cc = 0; cc < this.cols; cc++) {
                        try {
                            const c = this._cells[rr][cc];
                            if (c) c.visible = true;
                        } catch (e) {}
                    }
                }
                this._selection = [];
            } catch (e) {}
        };

        if (!animations$ || animations$.length === 0) {
            this.interactive = true;
            cleanup();
            return of(null).pipe(takeUntil(this._destroy$));
        }

        return forkJoin(animations$).pipe(
            takeUntil(this._destroy$),
            finalize(() => {
                this.interactive = true;
                cleanup();
            })
        );
    }
}
