/* 
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
*/
import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import { Amplify } from "aws-amplify";
import config from "./config";

//Amplify.Logger.LOG_LEVEL = 'DEBUG';
Amplify.configure({
  Auth: {
    mandatorySignIn: false,
    region: "eu-west-1"
  },
  Storage: {
    AWSS3: {
      bucket: config.content.bucket,
      region: config.content.REGION,
    },
    customPrefix: {
      public: config.content.prefix,
      protected: config.content.prefix,
      private: config.content.prefix,
    },
  },
  API: {
    endpoints: [
      {
        name: "docs",
        endpoint: config.apiGateway.URL,
        region: config.apiGateway.REGION
      },
    ]
  }
});

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);

