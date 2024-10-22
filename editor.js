
/**
 * @typedef {{
 * 		type: "attributes" | "characterData" | "childList";
 * 		target: Node;
 * 		addedNodes: Node[];
 * 		removedNodes: Node[];
 * 		previousSibling: Node | null;
 * 		nextSibling: Node | null;
 * 		attributeName: string | null;
 * 		attributeNamespace: string | null;
 * 		oldValue: string | null;
 * 		newValue: string | null;
 * }} UndoBufferRecord UndoBufferのための単一のDOM操作を示す要素(MutationRecordとほぼ同一)
 */

/**
 * @typedef {{
 * 		records: UndoBufferRecord[];
 *		oldRange: Range | null;
 *		newRange: Range | null;
 * }} UndoBufferPiece UndoBufferのための単一操作を示す要素
 */

/**
 * undoバッファ
 */
class UndoBuffer {
	/** @type { MutationObserver } DOMツリーの変更を監視するオブザーバ */
	#observer;
	/** @type { Node } 監視対象のノード */
	#target;
	/** @type { number } バッファサイズ */
	#bufferSize;
	/** @type { number } 現在のバッファのオフセット */
	#offset = 0;
	/** @type { number } 現在のバッファの位置 */
	#pos = 0;
	/** @type { number } 現在のバッファの終端位置 */
	#endPos = 0;
	/** @type { UndoBufferPiece[] } バッファ本体(リングバッファ) */
	#buffer = [];
	/** @type { MutationObserver } DOMツリーの変更を監視するオブザーバ(テンポラリ) */
	#tempObserver;
	/** @type { UndoBufferRecord[] } バッファ本体(テンポラリ) */
	#tempBuffer = [];
	/** @type { Range } 現在の選択範囲(実際にはRange互換のオブジェクトを保持) */
	#range = new Range();
	/** @type { Nomalizer } 正規化器 */
	#nomalizer;
	/** MutationObserverのオプション */
	static #observeOption = /** @type { const } */({
		characterData: true,
		characterDataOldValue: true,
		attributes: true,
		attributeOldValue: true,
		childList: true,
		subtree: true
	});
	/** 子要素のみを観測するMutationObserverのオプション */
	static #childObserveOption = /** @type { const } */({
		childList: true,
		subtree: true
	});

	/**
	 * コンストラクタ
	 * @param { Node } target 監視対象のノード
	 * @param { Nomalizer } nomalizer 正規化器
	 * @param { number } bufferSize バッファサイズ
	 */
	constructor(target, nomalizer, bufferSize = 50) {
		this.#target = target;
		this.#nomalizer = nomalizer;
		this.#bufferSize = bufferSize;
		this.#observer = new MutationObserver(records => {
			// ノード挿入の記録中は正規化などでDOM操作が行われるため観測を無効化する
			this.#observer.disconnect();
			this.push(this.#nomalizer.normalize(this.#target, records.map(v => ({
				type: v.type,
				target: v.target,
				addedNodes: [...v.addedNodes],
				removedNodes: [...v.removedNodes],
				previousSibling: v.previousSibling,
				nextSibling: v.nextSibling,
				attributeName: v.attributeName,
				attributeNamespace: v.attributeNamespace,
				oldValue: v.oldValue,
				// undo実施まで設定されることはない
				newValue: null
			}))), false);
			this.#observer.observe(this.#target, UndoBuffer.#observeOption);
		});
		this.#tempObserver = new MutationObserver(records => {
			this.#tempBuffer.push(...records.map(v => ({
				type: v.type,
				target: v.target,
				addedNodes: [...v.addedNodes],
				removedNodes: [...v.removedNodes],
				previousSibling: v.previousSibling,
				nextSibling: v.nextSibling,
				attributeName: v.attributeName,
				attributeNamespace: v.attributeNamespace,
				oldValue: v.oldValue,
				// undo実施まで設定されることはない
				newValue: null
			})));
		});

		this.#observer.observe(this.#target, UndoBuffer.#observeOption);

		// キャレット位置を監視
		const observeCaretEvent = () => this.#range = UndoBuffer.getCaret() || this.#range;
		this.#target.addEventListener('beforeinput', observeCaretEvent);

		// IME入力中は観測を無効化する
		let oldValue = '';
		this.#target.addEventListener('compositionstart', () => {
			// IMEによる入力中はキャレット位置を更新しない
			observeCaretEvent();
			this.#target.removeEventListener('beforeinput', observeCaretEvent);

			this.#observer.disconnect();
			// IMEによる入力中のDOMノードの編集の観測
			this.#tempBuffer = [];
			this.#tempObserver.observe(this.#target, UndoBuffer.#childObserveOption);

			// 厳密ではないかもしれないが現在の選択位置から持ってくる
			const textNode = this.#range.startContainer;
			oldValue = textNode.nodeValue;
		});
		this.#target.addEventListener('compositionend', e => {
			this.#target.addEventListener('beforeinput', observeCaretEvent);

			// 入力が取り消された場合はpushしない
			if (e.data.length > 0) {
				this.#tempObserver.disconnect();

				// 厳密ではないかもしれないが現在の選択位置から持ってくる
				const textNode = this.#range.startContainer;

				// 手動で操作内容をpushする
				this.push(this.#nomalizer.normalize(this.#target, [...this.#tempBuffer, {
					type: 'characterData',
					target: textNode,
					addedNodes: [],
					removedNodes: [],
					previousSibling: textNode.previousSibling,
					nextSibling: textNode.nextSibling,
					attributeName: null,
					attributeNamespace: null,
					oldValue: oldValue,
					newValue: null
				}]), false);

				this.#observer.observe(this.#target, UndoBuffer.#observeOption);
			}
			else {
				// マイクロタスクの実行まで評価を遅延する
				window.queueMicrotask(() => {
					this.#tempObserver.disconnect();

					// this.#tempBufferの内容を無効化する
					this.#undo(this.#tempBuffer);

					this.#observer.observe(this.#target, UndoBuffer.#observeOption);
				});
			}
		});
	}

	/**
	 * 現在のキャレット位置を取得する
	 * @returns { Range | null }
	 */
	static getCaret() {
		const selection = window.getSelection();
		if (selection.rangeCount > 0) {
			// cloneRangeをしてもDOM操作後になぜか無効になるため退避
			const range = selection.getRangeAt(0);
			return {
				startContainer: range.startContainer,
				startOffset: range.startOffset,
				endContainer: range.endContainer,
				endOffset: range.endOffset
			};
		}
		return null;
	}

	/**
	 * 操作内容のリストをundoバッファに追加する
	 * @param { UndoBufferPiece[] } records 操作内容のリスト
	 * @param { bool } mode trueの場合は最後に追加されたバッファへの追加、falseの場合は新規バッファの作成
	 */
	push(records, mode) {
		if (this.#bufferSize <= 0) {
			return;
		}

		if (mode) {
			// 最後に追加されたバッファへの追加
			const writePos = (this.#pos + this.#bufferSize - 1) % this.#bufferSize;
			if (this.#existBuffer(writePos)) {
				this.#buffer[writePos].records.push(...records);
			}
			else {
				// バッファが存在しないときは新規にバッファを追加する
				this.push(records, false);
			}
		}
		else {
			// 新規にバッファを追加する(別に直接インデックスを指定して代入しても問題ない)
			const piece = {
				records,
				oldRange: this.#range,
				newRange: UndoBuffer.getCaret()
			};
			if (this.#pos < this.#buffer.length) {
				this.#buffer[this.#pos] = piece;
			}
			else {
				this.#buffer.push(piece);
			}
			this.#endPos = this.#pos = (this.#pos + 1) % this.#bufferSize;
			// バッファサイズを超える場合はオフセットを移動する
			if (this.#pos == this.#offset) {
				this.#offset = (this.#offset + 1) % this.#bufferSize;
			}

			// 無効なバッファの削除
			if (this.#offset < this.#endPos) {
				for (let i = this.#endPos; i < this.#buffer.length; ++i) {
					this.#buffer[i] = [];
				}
				for (let i = 0; i < this.#offset; ++i) {
					this.#buffer[i] = [];
				}				
			}
			else {
				for (let i = this.#endPos; i < this.#offset; ++i) {
					this.#buffer[i] = [];
				}
			}
		}
	}

	/**
	 * バッファが存在するか
	 * @param { number } readPos バッファ位置
	 * @returns { bool } バッファが存在する場合はtrue、存在しない場合はfalse
	 */
	#existBuffer(readPos) {
		if (this.#offset != this.#endPos) {
			// readPosが区間[#offset, #endPos)に存在すること判定する
			if (this.#offset < this.#endPos) {
				return this.#offset <= readPos && readPos < this.#endPos;
			}
			else {
				return this.#offset <= readPos && readPos < this.#bufferSize || 0 <= readPos && readPos < this.#endPos;
			}
		}

		return false;
	}

	/**
	 * キャレットの情報の更新
	 * @param { Range } range 設定する選択範囲(実際にはRange互換のオブジェクトが設定される)
	 */
	static updateCaret(range) {
		const temp = document.createRange();
		temp.setStart(range.startContainer, range.startOffset);
		temp.setEnd(range.endContainer, range.endOffset);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(temp);
	}

	/**
	 * 操作内容のリストを元に戻すように実行する
	 * @param { UndoBufferRecord[] } records 操作内容のリスト
	 */
	#undo(records) {
		for (let i = records.length; i != 0; --i) {
			const op = records[i - 1];
			switch (op.type) {
				case 'characterData':
					// redoのために値の退避
					op.newValue = op.target.nodeValue;
					op.target.nodeValue = op.oldValue;
					break;
				case 'attributes':
					// redoのために値の退避
					if (op.attributeNamespace) {
						op.newValue = /** @type { Element } */(op.target).getAttributeNS(op.attributeNamespace, op.attributeName);
					}
					else {
						op.newValue = /** @type { Element } */(op.target).getAttribute(op.attributeName);
					}
					if (op.oldValue === null) {
						// 属性が存在しなかった場合は削除
						if (op.attributeNamespace) {
							/** @type { Element } */(op.target).removeAttributeNS(op.attributeNamespace, op.attributeName);
						}
						else {
							/** @type { Element } */(op.target).removeAttribute(op.attributeName);
						}
					}
					else {
						if (op.attributeNamespace) {
							/** @type { Element } */(op.target).setAttributeNS(op.attributeNamespace, op.attributeName, op.oldValue);
						}
						else {
							/** @type { Element } */(op.target).setAttribute(op.attributeName, op.oldValue);
						}
					}
					break;
				case 'childList':
					for (let j = op.addedNodes.length; j != 0; --j) {
						op.target.removeChild(op.addedNodes[j - 1]);
					}
					for (let j = op.removedNodes.length; j != 0; --j) {
						op.target.insertBefore(op.removedNodes[j - 1], op.nextSibling);
					}
					break;
			}
		}
	}

	/**
	 * 操作を元に戻す
	 */
	undo() {
		const readPos = (this.#pos + this.#bufferSize - 1) % this.#bufferSize;
		// 元に戻す操作がないときは何もしない
		if (this.#existBuffer(readPos)) {
			this.#observer.disconnect();

			// バッファの最後の要素から元に戻す操作を順に行う
			this.#undo(this.#buffer[readPos].records);
			// キャレットの更新
			UndoBuffer.updateCaret(this.#buffer[readPos].oldRange);

			// redoできるように位置を移動
			this.#pos = readPos;
			this.#observer.observe(this.#target, UndoBuffer.#observeOption);
		}
	}

	/**
	 * 操作内容のリストを実行する
	 * @param { UndoBufferRecord[] } records 操作内容のリスト
	 */
	#redo(records) {
		for (const op of records) {
			switch (op.type) {
				case 'characterData':
					op.target.nodeValue = op.newValue;
					break;
				case 'attributes':
					if (op.newValue === null) {
						// 属性が存在しなかった場合は削除
						if (op.attributeNamespace) {
							/** @type { Element } */(op.target).removeAttributeNS(op.attributeNamespace, op.attributeName);
						}
						else {
							/** @type { Element } */(op.target).removeAttribute(op.attributeName);
						}
					}
					else {
						if (op.attributeNamespace) {
							/** @type { Element } */(op.target).setAttributeNS(op.attributeNamespace, op.attributeName, op.newValue);
						}
						else {
							/** @type { Element } */(op.target).setAttribute(op.attributeName, op.newValue);
						}
					}
					break;
				case 'childList':
					for (const node of op.addedNodes) {
						op.target.insertBefore(node, op.nextSibling);
					}
					for (const node of op.removedNodes) {
						op.target.removeChild(node);
					}
					break;
			}
		}
	}

	/**
	 * 操作を前に進める
	 */
	redo() {
		const readPos = this.#pos;
		// 前に進める操作がないときは何もしない
		if (this.#existBuffer(readPos)) {
			this.#observer.disconnect();

			// バッファの最初の要素から前に進める操作を順に行う
			this.#redo(this.#buffer[readPos].records);
			// キャレットの更新
			UndoBuffer.updateCaret(this.#buffer[readPos].newRange);

			// undoできるように位置を移動
			this.#pos = (this.#pos + 1) % this.#bufferSize;
			this.#observer.observe(this.#target, UndoBuffer.#observeOption);
		}
	}
}

/**
 * 正規化器
 */
class Nomalizer {

	/**
	 * 操作内容に関する特定のDOMノードを置換する
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { Node } node 置換対象
	 * @param { Node } target UndoBufferRecord.targetへの置換内容
	 * @param { Node | null } previousSibling UndoBufferRecord.previousSiblingへの置換内容
	 * @param { Node | null } nextSibling UndoBufferRecord.nextSiblingへの置換内容
	 * @param { number } begin recordsの始端
	 * @param { number } end recordsの終端
	 */
	static replaceOperation(records, node, target, previousSibling, nextSibling, begin, end) {
		while (begin !== end) {
			if (records[begin].type === 'childList') {
				if (records[begin].target === node) {
					records[begin].target = target;
				}
				if (records[begin].previousSibling === node) {
					records[begin].previousSibling = previousSibling;
				}
				if (records[begin].nextSibling === node) {
					records[begin].nextSibling = nextSibling;
				}
			}
			else if (records[begin].target === node) {
				// 置換によりnodeは'childList'に関する操作以外は意味はないため削除
				records.splice(begin, 1);
				--end;
				continue;
			}
			++begin;
		}
	}

	/**
	 * 操作内容に挿入情報を挿入する
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { Node } target 挿入先
	 * @param { NodeList | Node[] } nodes 挿入内容
	 * @param { number } index 挿入操作の挿入先
	 */
	static insertInsertOperation(records, target, nodes, index = records.length) {
		if (nodes.length === 0) {
			return;
		}
		records.splice(index, 0, {
			type: 'childList',
			target: target,
			addedNodes: nodes,
			removedNodes: [],
			previousSibling: nodes[0].previousSibling,
			nextSibling: nodes[nodes.length - 1].nextSibling,
			attributeName: null,
			attributeNamespace: null,
			oldValue: null,
			newValue: null
		});
	}

	/**
	 * 挿入操作を取り消す
	 * @param { Range | null } range キャレット情報(実際にはRange互換のオブジェクトが設定される)
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { number } i recordのインデックス
	 * @param { number } j 挿入したノードのインデックス
	 * @returns { [number, number] } 削除後のインデックス[i, j]
	 */
	static cancelInsertOperation(records, i, j) {
		// 以下のようなパラメータチェックは行わない
		// records[i].type === 'childList'
		
		const op = records[i];
		op.addedNodes.splice(j, 1);
		--j;
		if (op.addedNodes.length === 0) {
			records.splice(i, 1);
			--i;
		}

		return [i, j];
	}

	/**
	 * 子要素としてのインデックスを取得する
	 * @param { Node } node 位置を検索する対象のノード
	 * @returns { number } nodeの子要素としてのインデックス
	 */
	static getChildIndex(node) {
		let i = 0;
		while((node = node.previousSibling) != null)  {
			++i;
		}
		return i;
	}

	/**
	 * 一括でノードの移動を行う(移動対象に関する操作内容の編集は行わない)
	 * @param { Range | null } range キャレット情報(実際にはRange互換のオブジェクトが設定される)
	 * @param { NodeList | Node[] } targets 移動対象のノード(全ての親ノードは共通かつ連続である必要がある)
	 * @param { ParentNode } refParent 移動先の親ノード
	 * @param { Node | null } ref 移動先の次のノード
	 */
	static moveNodeList(range, targets, refParent, ref = null) {
		if (targets.length === 0) {
			return;
		}

		// キャレット位置の再計算のための計算
		const targetsParent = targets[0].parentNode;
		const offset = Nomalizer.getChildIndex(targets[0]);
		const childIndex = ref ? Nomalizer.getChildIndex(ref) : refParent.childNodes.length;

		// ノードを挿入する
		if (ref) {
			for (const target of targets) {
				refParent.insertBefore(target, ref);
			}
		}
		else {
			// 移動先の指定がないときは末尾に一括で追加する
			refParent.append(...targets);
		}

		// キャレット位置をtargetsParentからrefParentに付け替える
		if (range) {
			if (range.startContainer === targetsParent && offset <= range.startOffset && range.startOffset <= offset + targets.length) {
				range.startContainer = refParent;
				range.startOffset = range.startOffset - offset + childIndex;
			}
			if (range.endContainer === targetsParent && offset <= range.endOffset && range.endOffset <= offset + targets.length) {
				range.endContainer = refParent;
				range.endOffset = range.endOffset - offset + childIndex;
			}
			if (targetsParent === null) {
				// 移動のない単純なノードの挿入だった場合はオフセットを再計算
				if (range.startContainer === refParent && childIndex <= range.startOffset) {
					range.startOffset += targets.length;
				}
				if (range.endContainer === refParent && childIndex <= range.endOffset) {
					range.endOffset += targets.length;
				}
			}
		}
	}

	/**
	 * 挿入操作を別のノードとしての挿入操作に置換する
	 * @param { Range | null } range キャレット情報(実際にはRange互換のオブジェクトが設定される)
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { number } i recordのインデックス
	 * @param { number } j 挿入したノードのインデックス
	 * @param { Node } target 置換内容
	 */
	static replaceNodeAndInsertOperation(records, i, j, target) {
		// 以下のようなパラメータチェックは行わない
		// records[i].type === 'childList'

		const op = records[i];
		const node = op.addedNodes[j];
		op.target.replaceChild(target, node);
		op.addedNodes[j] = target;
		// nodeに関する操作内容をtargetに置き換える
		Nomalizer.replaceOperation(records, node, target, target, target, i + 1, records.length);
	}

	/**
	 * 子要素のノードと操作内容を現在位置で展開して展開元は削除する
	 * @param { Range | null } range キャレット情報(実際にはRange互換のオブジェクトが設定される)
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { number } i recordのインデックス
	 * @param { number } j 挿入したノードのインデックス
	 * @returns { [number, number] } 削除後のインデックス[i, j]
	 */
	static expandChildNodesAndInsertOperation(range, records, i, j) {
		// 以下のようなパラメータチェックは行わない
		// records[i].type === 'childList'
		
		const op = records[i];
		const node = op.addedNodes[j];
		const ref = node.nextSibling;
		const childIndex = Nomalizer.getChildIndex(node);
		// 挿入操作を完全に取り消す
		[i, j] = Nomalizer.cancelInsertOperation(records, i, j);
		op.target.removeChild(node);

		// キャレット位置のオフセットを削除した1つ分ずらす
		if (range) {
			if (range.startContainer === op.target && childIndex < range.startOffset) {
				--range.startOffset;
			}
			if (range.endContainer === op.target && childIndex < range.endOffset) {
				--range.endOffset;
			}
		}

		// node自体が不要で子ノードはその場に展開する指定があれば展開する
		if (node.childNodes.length !== 0) {
			// 削除したノードの元の隣接しているノードや子の接続情報を書き換え
			Nomalizer.replaceOperation(
				records,
				node,
				op.target,
				node.childNodes[node.childNodes.length - 1],
				node.childNodes[0],
				i + 1, records.length
			);
			Nomalizer.moveNodeList(range, node.childNodes, op.target, ref);
		}

		return [i, j];
	}

	/**
	 * 挿入操作を別の既存のノードへの挿入に変更して同時にノードも移動する
	 * @param { Range | null } range キャレット情報(実際にはRange互換のオブジェクトが設定される)
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { number } i recordのインデックス
	 * @param { number } j 挿入したノードのインデックス
	 * @param { Node } target 移動先(既存のノード)
	 * @returns { [number, number] } 移動後のインデックス[i, j]
	 */
	static moveNodeAndInsertOperation(range, records, i, j, target) {
		const op = records[i];
		const node = op.addedNodes[j];

		const prev = node.previousSibling;
		const next = node.nextSibling;

		// 挿入操作をキャンセル
		[i, j] = Nomalizer.cancelInsertOperation(records, i, j);
		// 削除したノードの元の隣接しているノードや子の接続情報を書き換え
		Nomalizer.replaceOperation(records, node,  op.target, prev, next, i + 1, records.length);
		// ノードの移動
		Nomalizer.moveNodeList(range, [node], target);
		// nodeの挿入操作を再挿入する
		Nomalizer.insertInsertOperation(records, target, [node]);

		return [i, j];
	}

	/**
	 * 新規構築したノードの挿入操作を構築して既存の挿入操作の挿入先をそのノードに変更し同時にノードも移動する
	 * @param { Range | null } range キャレット情報(実際にはRange互換のオブジェクトが設定される)
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @param { number } i recordのインデックス
	 * @param { number } j 挿入したノードのインデックス
	 * @param { Node } parent 新規に構築した親ノード
	 */
	static insertParentNodeAndInsertOperation(range, records, i, j, parent) {
		const op = records[i];
		const node = op.addedNodes[j];

		// 挿入操作を新規に構築した親ノードの挿入に変更
		Nomalizer.replaceNodeAndInsertOperation(records, i, j, parent);
		// ノード移動についてのキャレット位置計算のために一時的に挿入
		parent.parentNode.insertBefore(node, parent);
		// 元のノードを新規に構築した親ノードの子に変更
		Nomalizer.moveNodeList(range, [node], parent);
		// nodeの挿入操作をparentの挿入操作の次として挿入する
		Nomalizer.insertInsertOperation(records, parent, [node], i + 1);
	}

	/**
	 * DOM構造の正規化を行う
	 * @param { Element } root ルート要素
	 * @param { UndoBufferRecord[] } records 操作内容
	 * @returns { UndoBufferRecord[] } 正規化を行た結果の操作
	 */
	normalize(root, records) {
		const range = UndoBuffer.getCaret();

		for (let i = 0; i != records.length; ++i) {
			const op = records[i];
			if (op.type === 'childList') {
				for (let j = 0; j != op.addedNodes.length; ++j) {
					const node = op.addedNodes[j];
					// 現在targetに挿入されているノードのみを評価対象にする
					if (node.parentNode === op.target) {
						if (node.nodeType === Node.TEXT_NODE && op.target === root) {
							// ルート要素へのテキスト要素の挿入は段落要素への挿入に置き換える
							Nomalizer.insertParentNodeAndInsertOperation(range, records, i, j, document.createElement('p'));
						}
						else if ((() => { for (const child of node.childNodes) { if (child.nodeType === Node.TEXT_NODE) return true; } return false; })()) {
							if ((node.nodeType !== Node.ELEMENT_NODE || /** @type { Element } */(node).tagName.toLowerCase() === 'div') && op.target === root) {
								// ルート要素へのテキスト要素を含むdivの挿入は段落要素の挿入に置き換える
								const p = document.createElement('p');
								Nomalizer.replaceNodeAndInsertOperation(records, i, j, p);
								Nomalizer.moveNodeList(range, node.childNodes, p);
							}
						}
						else if (node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.ELEMENT_NODE && /** @type { Element } */(node.childNodes[0]).tagName.toLowerCase() === 'br') {
							if ((node.nodeType !== Node.ELEMENT_NODE || /** @type { Element } */(node).tagName.toLowerCase() !== 'p') && op.target === root) {
								// 改行を親に持っていくことでルート要素直下の段落要素へのルートに持っていく
								[i, j] = Nomalizer.expandChildNodesAndInsertOperation(range, records, i, j);
							}
						}
						else if (node.nodeType === Node.ELEMENT_NODE && /** @type { Element } */(node).tagName.toLowerCase() === 'br' && op.target === root) {
							// ルート要素への改行要素の挿入は直前の段落要素の挿入への改行に置き換える
							// 直前の段落が存在しない場合は新規に段落を設置する
							if (node.previousSibling?.nodeType !== Node.ELEMENT_NODE || /** @type { Element } */(node.previousSibling).tagName.toLowerCase() !== 'p') {
								Nomalizer.insertParentNodeAndInsertOperation(range, records, i, j, document.createElement('p'));
							}
							else {
								[i, j] = Nomalizer.moveNodeAndInsertOperation(range, records, i, j, node.previousSibling);
							}
						}
						else if (node.nodeType === Node.ELEMENT_NODE && /** @type { Element } */(node).tagName.toLowerCase() === 'br') {
							if (node.previousSibling && (node.previousSibling.nodeType !== Node.ELEMENT_NODE || /** @type { Element } */(node.previousSibling).tagName.toLowerCase() !== 'br') && node.nextSibling === null) {
								// 空行の表示のためにもう1つ改行を挿入する(2つ以上brが並ばないと空行は表示されない)
								const br = document.createElement('br');
								Nomalizer.moveNodeList(range, [br], node.parentNode, node);
								Nomalizer.insertInsertOperation(records, node.parentNode, [br]);
							}
						}
						else {
							if (node.nodeType === Node.ELEMENT_NODE && /** @type { Element } */(node).tagName.toLowerCase() === 'p') {
								let parent = node.parentNode;
								while (parent !== root) {
									if (parent.nodeType === Node.ELEMENT_NODE && /** @type { Element } */(parent).tagName.toLowerCase() === 'p') {
										// 段落のネストは段落を解除して子要素を親に展開する
										[i, j] = Nomalizer.expandChildNodesAndInsertOperation(range, records, i, j);
										break;
									}
									parent = parent.parentNode;
								}
							}
						}
					}
				}
			}
		}

		// ブラウザによってはDOM操作後にキャレットに変更がなくても明示的に更新しないと表示が更新されないことがあるため明示的に更新する
		UndoBuffer.updateCaret(range);

		return records;
	}
}


/**
 * Shift + Enter入力時の動作
 * @param { Element } root ルート要素
 */
function shiftEnter(root) {
	const selection = window.getSelection();
	if (selection.rangeCount > 0) {
		const range = selection.getRangeAt(0);
		if (!range.collapsed) {
			// rangeの始点と終点が一致しないときは範囲を削除
			range.deleteContents();
			range.collapse();
		}
		const startContainer = range.startContainer;
		const startOffset = range.startOffset;

		// targetに改行要素を挿入する
		// range.insertNodeでは空のTextノードができることがあるため利用しない
		const br = document.createElement('br');
		switch (startContainer.nodeType) {
			case Node.TEXT_NODE:
				// startOffsetでテキストノードを分割してその間に改行を挿入する
				if (startOffset === 0) {
					startContainer.parentNode.insertBefore(br, startContainer);
				}
				else if (startOffset === /** @type { Text } */(startContainer).length) {
					startContainer.parentNode.insertBefore(br, startContainer.nextSibling);
				}
				else {
					const newNode = /** @type { Text } */(startContainer).splitText(startOffset);
					startContainer.parentNode.insertBefore(br, newNode);
				}
				break;
			case Node.COMMENT_NODE:
			case Node.CDATA_SECTION_NODE:
				// 無視する
				return;
			default:
				// startOffset番目の子要素の位置に改行を挿入する
				startContainer.insertBefore(br, startOffset === startContainer.childNodes.length ? null : startContainer.childNodes[startOffset]);
				break;
		}
		// キャレットを改行の次の位置に移動
		const offset = Nomalizer.getChildIndex(br);
		range.setStart(br.parentNode, offset + 1);
		range.setEnd(br.parentNode, offset + 1);
	}
}

/**
 * Enter入力時の動作
 * @param { Element } root ルート要素
 */
function enter(root) {
	const selection = window.getSelection();
	if (selection.rangeCount > 0) {
		const range = selection.getRangeAt(0);
		if (!range.collapsed) {
			// rangeの始点と終点が一致しないときは範囲を削除
			range.deleteContents();
			range.collapse();
		}
		const startContainer = range.startContainer;
		const startOffset = range.startOffset;

		// ノードの分割範囲の取得
		const rangeExtract = range.cloneRange();
		// ノードの分割範囲の始端の取得
		switch (startContainer.nodeType) {
			case Node.TEXT_NODE:
				// startOffsetでテキストノードを分割してその間に改行を挿入する
				if (startOffset === 0) {
					rangeExtract.setStart(startContainer.parentNode, Nomalizer.getChildIndex(startContainer));
				}
				else if (startOffset === /** @type { Text } */(startContainer).length) {
					rangeExtract.setStart(startContainer.parentNode, Nomalizer.getChildIndex(startContainer) + 1);
				}
				else {
					const newNode = /** @type { Text } */(startContainer).splitText(startOffset);
					rangeExtract.setStart(startContainer.parentNode, Nomalizer.getChildIndex(newNode));
				}
				rangeExtract.setEnd(rangeExtract.startContainer, rangeExtract.startOffset);
				break;
			case Node.COMMENT_NODE:
			case Node.CDATA_SECTION_NODE:
				// 無視する
				return;
			default:
				break;
		}
		// ノードの分割範囲の終端の取得
		let parent = startContainer;
		while (parent !== root) {
			if (parent.nodeType === Node.ELEMENT_NODE && /** @type { Element } */(parent).tagName.toLowerCase() === 'p') {
				rangeExtract.setEnd(parent.parentNode, parent.nextSibling ? Nomalizer.getChildIndex(parent) + 1 : parent.parentNode.childNodes.length);
				break;
			}
			parent = parent.parentNode;
		}

		const br = document.createElement('br');
		const ref = rangeExtract.endContainer;
		const refOffset = rangeExtract.endOffset;
		if (rangeExtract.collapsed) {
			// ノードの分割範囲の始端と終端が一致するときは新規の改行付き段落を挿入
			const p = document.createElement('p');
			ref.insertBefore(p, refOffset === ref.childNodes.length ? null : ref.childNodes[refOffset]);

			p.append(br);
		}
		else {
			// ノードの分割範囲の始端と終端が一致しないときは分割をして空段落でなければ分割をしたノードの子に改行を挿入
			const p = rangeExtract.extractContents().firstChild;
			ref.insertBefore(p, refOffset === ref.childNodes.length ? null : ref.childNodes[refOffset]);
			if (p.childNodes.length !== 0) {
				// 段落内に要素が存在する場合は改行の挿入は不要
				// キャレット位置は分割された要素の始端
				let child = p.firstChild;
				while (child.firstChild) {
					child = child.firstChild
				}
				switch (startContainer.nodeType) {
					case Node.TEXT_NODE:
					case Node.COMMENT_NODE:
					case Node.CDATA_SECTION_NODE:
						range.setStart(child, 0);
						range.setEnd(child, 0);
						break;
					default:
						range.setStart(child.parentNode, 0);
						range.setEnd(child.parentNode, 0);
						break;
				}
				return;
			}
			p.append(br);
		}
		// キャレットを改行の次の位置に移動
		const offset = Nomalizer.getChildIndex(br);
		range.setStart(br.parentNode, offset + 1);
		range.setEnd(br.parentNode, offset + 1);
	}
}
