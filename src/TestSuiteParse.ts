import { TestSuiteInfo } from 'vscode-test-adapter-api';


export interface TargetInfo {
    type: 'suite';
    id: string;
    /** The label to be displayed by the Test Explorer for this suite. */
    label: string;
    /** The description to be displayed next to the label. */
    description: string;
    /** The tooltip text to be displayed by the Test Explorer when you hover over this suite. */
    tooltip: string;
    /**
     * The file containing this suite (if known).
     * This can either be an absolute path (if it is a local file) or a URI.
     * Note that this should never contain a `file://` URI.
     */
    file?: string;
    /** The line within the specified file where the suite definition starts (if known). */
    line?: number;
    /** Set this to `false` if Test Explorer shouldn't offer debugging this suite. */
    debuggable?: boolean;
    childrens: {[key: string]: (TestSuiteInfo)};
    /** Set this to `true` if there was an error while loading the suite */
    errored?: boolean;
    /**
     * This message will be displayed by the Test Explorer when the user selects the suite.
     * It is usually used for information about why the suite was set to errored.
     */
    message?: string;
}